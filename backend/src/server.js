import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { createDatabase, getRecentGenerations, saveGeneration } from './database.js';
import { buildMessages } from './prompts.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedLanguages = new Set([
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'csharp',
  'sql', 'html', 'css', 'json',
]);
const activeRequests = new Set();
const maximumConcurrentRequests = 3;

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/history', async (_request, response, next) => {
  try {
    response.json(await getRecentGenerations(app.locals.database));
  } catch (error) {
    next(error);
  }
});

app.post('/api/generate', async (request, response) => {
  const { prompt, language } = request.body ?? {};
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 8000) {
    response.status(400).json({ error: 'Prompt must contain 1–8000 characters.' });
    return;
  }
  if (typeof language !== 'string' || !allowedLanguages.has(language)) {
    response.status(400).json({ error: 'Choose a supported programming language.' });
    return;
  }
  if (!process.env.DOUBAO_API_KEY || !process.env.DOUBAO_MODEL_ID) {
    response.status(503).json({ error: 'Configure DOUBAO_API_KEY and DOUBAO_MODEL_ID to enable code generation.' });
    return;
  }
  if (activeRequests.size >= maximumConcurrentRequests) {
    response.status(429).json({ error: 'The assistant is busy. Please try again shortly.' });
    return;
  }

  const requestId = randomUUID();
  const controller = new AbortController();
  activeRequests.add(requestId);
  response.on('close', () => {
    activeRequests.delete(requestId);
    if (!response.writableEnded) controller.abort();
  });

  let code = '';
  let streamStarted = false;
  try {
    const configuredBaseUrl = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
    const baseUrl = configuredBaseUrl
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/+$/, '');
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DOUBAO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DOUBAO_MODEL_ID,
        messages: buildMessages({ prompt: prompt.trim(), language }),
        stream: true,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 1000);
      throw new Error(`Doubao API returned ${upstream.status}: ${detail}`);
    }
    if (!upstream.body) throw new Error('Doubao API returned an empty response stream.');

    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    streamStarted = true;

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const forwardFrame = (frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') return;

      let event;
      try {
        event = JSON.parse(data);
      } catch (error) {
        throw new Error('Doubao API returned malformed stream data.', { cause: error });
      }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        code += delta;
        response.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      if (event.error) throw new Error(event.error.message || 'Doubao API stream failed.');
    };

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || '';

      for (const frame of frames) forwardFrame(frame);

      if (done) break;
    }
    if (pending.trim()) forwardFrame(pending);

    await saveGeneration(app.locals.database, {
      id: requestId,
      prompt: prompt.trim(),
      language,
      code,
    });
    response.write(`data: ${JSON.stringify({ done: true, id: requestId })}\n\n`);
    response.end();
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('Code generation failed:', error);
    if (streamStarted && !response.destroyed) {
      response.write(`data: ${JSON.stringify({ error: 'Code generation failed. Check the server logs and try again.' })}\n\n`);
      response.end();
    } else if (!response.headersSent) {
      response.status(502).json({ error: 'Could not reach the Doubao API. Check the server logs and try again.' });
    }
  } finally {
    activeRequests.delete(requestId);
  }
});

app.use((error, _request, response, _next) => {
  console.error('Request failed:', error);
  if (response.headersSent) {
    response.end();
    return;
  }
  response.status(error.status || 500).json({
    error: error.status ? error.message : 'An unexpected server error occurred.',
  });
});

try {
  app.locals.database = await createDatabase();
  app.listen(port, () => {
    console.info(`AI Code Helper API listening on http://localhost:${port}`);
  });
} catch (error) {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
}
