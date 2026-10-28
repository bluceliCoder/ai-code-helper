<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';
import {
  Activity, ArrowUp, Check, ChevronDown, Code2, Copy, FileCode2, History,
  LoaderCircle, PanelLeftClose, Plus, Sparkles, Square, WandSparkles,
} from '@lucide/vue';

interface HistoryItem {
  id: string;
  prompt: string;
  language: string;
  code: string;
  created_at: string;
}

const languages = [
  { id: 'javascript', name: 'JavaScript', extension: 'js' },
  { id: 'typescript', name: 'TypeScript', extension: 'ts' },
  { id: 'python', name: 'Python', extension: 'py' },
  { id: 'java', name: 'Java', extension: 'java' },
  { id: 'go', name: 'Go', extension: 'go' },
  { id: 'rust', name: 'Rust', extension: 'rs' },
  { id: 'csharp', name: 'C#', extension: 'cs' },
  { id: 'sql', name: 'SQL', extension: 'sql' },
  { id: 'html', name: 'HTML', extension: 'html' },
  { id: 'css', name: 'CSS', extension: 'css' },
  { id: 'json', name: 'JSON', extension: 'json' },
];
const selectedLanguage = ref(languages[1]);
const prompt = ref('');
const isGenerating = ref(false);
const hasReceivedContent = ref(false);
const isCopied = ref(false);
const history = ref<HistoryItem[]>([]);
const historyError = ref('');
const editorHost = ref<HTMLElement | null>(null);
const sidebarOpen = ref(true);
const editorReady = ref(false);
const codeLength = ref(0);
const editorError = ref('');
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let abortController: AbortController | undefined;
let copyTimer: number | undefined;
let displayQueue = '';
let displayFrame: number | undefined;

const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
const fileName = computed(() => `generated.${selectedLanguage.value.extension}`);
const generationLabel = computed(() => isGenerating.value ? '生成中' : '豆包 · AI 编程助手');

function updateEditorCode(value: string) {
  if (!editor) return;
  editor.setValue(value);
  codeLength.value = value.length;
}

function appendEditorCode(text: string) {
  if (!editor || !text) return;
  const model = editor.getModel();
  const end = model?.getFullModelRange().getEndPosition();
  if (!model || !end) return;

  model.applyEdits([{
    range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
    text,
    forceMoveMarkers: true,
  }]);
  codeLength.value = model.getValueLength();
  editor.revealPosition(model.getFullModelRange().getEndPosition());
}

function flushTypewriter() {
  displayFrame = undefined;
  if (!displayQueue || !editor) return;

  const nextText = displayQueue.slice(0, 4);
  displayQueue = displayQueue.slice(nextText.length);
  appendEditorCode(nextText);
  if (displayQueue) displayFrame = requestAnimationFrame(flushTypewriter);
}

function queueCode(delta: string) {
  hasReceivedContent.value = true;
  displayQueue += delta;
  if (displayFrame === undefined) displayFrame = requestAnimationFrame(flushTypewriter);
}

function flushPendingCode() {
  if (displayFrame !== undefined) {
    cancelAnimationFrame(displayFrame);
    displayFrame = undefined;
  }
  const remaining = displayQueue;
  displayQueue = '';
  appendEditorCode(remaining);
}

async function loadHistory() {
  try {
    const response = await fetch(`${apiBase}/api/history`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: '无法加载生成历史。' }));
      throw new Error(body.error || '无法加载生成历史。');
    }
    history.value = await response.json() as HistoryItem[];
    historyError.value = '';
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : '无法连接到服务端。';
  }
}

function selectHistory(item: HistoryItem) {
  const language = languages.find((entry) => entry.id === item.language);
  if (language) selectedLanguage.value = language;
  prompt.value = item.prompt;
  updateEditorCode(item.code);
}

function consumeEventFrame(frame: string, onDelta: (delta: string) => void, onDone: () => void) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return;
  const event = JSON.parse(data) as { delta?: string; done?: boolean; error?: string };
  if (event.delta) onDelta(event.delta);
  if (event.done) onDone();
  if (event.error) throw new Error(event.error);
}

async function generateCode() {
  if (isGenerating.value) return;
  if (!prompt.value.trim()) {
    editorError.value = '先描述一下你想生成的代码吧。';
    return;
  }

  editorError.value = '';
  isGenerating.value = true;
  hasReceivedContent.value = false;
  displayQueue = '';
  updateEditorCode('');
  abortController = new AbortController();
  try {
    const response = await fetch(`${apiBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value.trim(), language: selectedLanguage.value.id }),
      signal: abortController.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (typeof body?.error === 'string') throw new Error(body.error);
      if (response.status >= 500) {
        throw new Error('后端 API 暂时不可用，请确认后端服务已启动。');
      }
      throw new Error('生成请求失败，请检查输入后重试。');
    }
    if (!response.body) throw new Error('浏览器未能打开流式响应。');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let doneEvent = false;
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || '';
      for (const frame of frames) {
        consumeEventFrame(frame, (delta) => {
          queueCode(delta);
        }, () => {
          doneEvent = true;
        });
      }
      if (done) break;
    }
    if (pending.trim()) {
      consumeEventFrame(pending, (delta) => {
        queueCode(delta);
      }, () => {
        doneEvent = true;
      });
    }
    flushPendingCode();
    if (doneEvent) await loadHistory();
    else if (!abortController.signal.aborted) throw new Error('流式响应意外结束，请重试。');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      editorError.value = '已停止生成。';
    } else if (error instanceof TypeError) {
      editorError.value = '无法连接后端 API，请在项目根目录运行 npm run dev 并检查后端启动日志。';
    } else {
      editorError.value = error instanceof Error ? error.message : '生成失败，请重试。';
    }
  } finally {
    flushPendingCode();
    isGenerating.value = false;
    abortController = undefined;
  }
}

function stopGeneration() {
  abortController?.abort();
}

async function copyCode() {
  if (!editor) return;
  try {
    await navigator.clipboard.writeText(editor.getValue());
    isCopied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      isCopied.value = false;
    }, 1800);
  } catch {
    editorError.value = '无法访问剪贴板，请检查浏览器权限。';
  }
}

function startNewFile() {
  prompt.value = '';
  editorError.value = '';
  updateEditorCode('');
}

watch(selectedLanguage, (language) => {
  const model = editor?.getModel();
  if (model) monaco.editor.setModelLanguage(model, language.id);
});

onMounted(async () => {
  await nextTick();
  if (!editorHost.value) return;
  monaco.editor.defineTheme('codepilot-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#101218',
      'editorLineNumber.foreground': '#454957',
      'editorLineNumber.activeForeground': '#9da3b4',
      'editorCursor.foreground': '#a78bfa',
      'editor.selectionBackground': '#39334f',
      'editor.lineHighlightBackground': '#ffffff05',
      'editorIndentGuide.background1': '#ffffff0a',
    },
  });
  editor = monaco.editor.create(editorHost.value, {
    value: '',
    language: selectedLanguage.value.id,
    theme: 'codepilot-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    lineHeight: 23,
    tabSize: 2,
    padding: { top: 20, bottom: 20 },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    guides: { indentation: true, bracketPairs: true },
    wordWrap: 'on',
    readOnly: true,
  });
  editorReady.value = true;
  await loadHistory();
});

onBeforeUnmount(() => {
  abortController?.abort();
  displayQueue = '';
  if (displayFrame !== undefined) cancelAnimationFrame(displayFrame);
  displayFrame = undefined;
  window.clearTimeout(copyTimer);
  editor?.dispose();
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><Code2 :size="19" stroke-width="2.2" /></div>
        <span class="brand-name">codepilot<span class="brand-dot">.</span></span>
        <span class="brand-divider"></span>
        <span class="brand-caption">AI 开发工作台</span>
      </div>
      <div class="topbar-right">
        <div class="model-status"><span class="status-dot"></span><span>{{ generationLabel }}</span></div>
        <div class="avatar">D</div>
      </div>
    </header>

    <div class="app-body">
      <aside v-if="sidebarOpen" class="sidebar">
        <button class="new-file-button" type="button" @click="startNewFile">
          <Plus :size="16" /><span>新建代码</span><span class="shortcut">⌘ K</span>
        </button>
        <div class="sidebar-section">
          <div class="section-heading"><span>工作区</span></div>
          <div class="workspace-row active"><FileCode2 :size="16" /><span>未命名项目</span><span class="workspace-count">1</span></div>
        </div>
        <div class="sidebar-section history-section">
          <div class="section-heading"><span>最近生成</span><History :size="14" /></div>
          <button
            v-for="item in history"
            :key="item.id"
            class="history-item"
            type="button"
            :title="item.prompt"
            @click="selectHistory(item)"
          >
            <FileCode2 :size="15" />
            <span class="history-copy">{{ item.prompt }}</span>
            <span class="history-language">{{ item.language }}</span>
          </button>
          <p v-if="history.length === 0" class="history-empty">
            {{ historyError || '生成的代码会显示在这里' }}
          </p>
        </div>
        <div class="sidebar-bottom">
          <div class="usage-card">
            <div class="usage-icon"><Activity :size="15" /></div>
            <div><strong>灵感随时就绪</strong><p>描述想法，开始构建</p></div>
            <Sparkles :size="15" class="usage-sparkle" />
          </div>
          <div class="profile-row"><div class="profile-avatar">D</div><div><strong>开发者</strong><span>个人工作区</span></div><ChevronDown :size="15" /></div>
        </div>
      </aside>

      <main class="workspace">
        <div class="workspace-header">
          <div class="breadcrumbs">
            <button class="icon-button sidebar-toggle" type="button" aria-label="切换侧边栏" @click="sidebarOpen = !sidebarOpen">
              <PanelLeftClose :size="17" />
            </button>
            <span class="breadcrumb-project">未命名项目</span><span class="breadcrumb-slash">/</span>
            <FileCode2 :size="14" class="breadcrumb-file-icon" /><span class="breadcrumb-file">{{ fileName }}</span>
            <span class="unsaved-dot"></span>
          </div>
          <div class="workspace-actions">
            <button class="icon-button copy-button" type="button" title="复制代码" @click="copyCode">
              <Check v-if="isCopied" :size="15" /><Copy v-else :size="15" />
              <span>{{ isCopied ? '已复制' : '复制' }}</span>
            </button>
            <span class="action-divider"></span>
            <button class="language-select" type="button" @click="($refs.languageMenu as HTMLElement).hidden = !($refs.languageMenu as HTMLElement).hidden">
              <span class="language-dot"></span>{{ selectedLanguage.name }}<ChevronDown :size="13" />
            </button>
            <div ref="languageMenu" class="language-menu" hidden>
              <button v-for="language in languages" :key="language.id" type="button" @click="selectedLanguage = language; ($refs.languageMenu as HTMLElement).hidden = true">
                {{ language.name }}
              </button>
            </div>
          </div>
        </div>

        <section class="editor-frame" :class="{ 'is-generating': isGenerating }">
          <div class="editor-toolbar">
            <div class="editor-tab"><span class="file-type-icon">{{ selectedLanguage.extension }}</span><span>{{ fileName }}</span><span class="tab-unsaved"></span></div>
            <div class="editor-toolbar-right"><span>UTF-8</span><span class="toolbar-separator">·</span><span>{{ selectedLanguage.name }}</span></div>
          </div>
          <div ref="editorHost" class="editor-host">
            <div v-if="!editorReady" class="editor-loading"><LoaderCircle :size="18" class="spin" />正在启动编辑器…</div>
            <div v-else-if="isGenerating && !hasReceivedContent" class="generation-overlay" role="status" aria-live="polite">
              <LoaderCircle :size="20" class="spin generation-spinner" />
              <span>正在连接豆包模型，准备生成代码…</span>
              <span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            </div>
          </div>
          <div class="editor-status">
            <div><span class="status-branch"><Code2 :size="13" /> main</span><span class="status-divider"></span><span v-if="isGenerating" class="stream-status"><span class="stream-status-dot"></span>{{ hasReceivedContent ? '实时生成' : '连接模型' }}</span><span v-else>就绪</span></div>
            <div><span>Ln {{ codeLength ? codeLength.toLocaleString() : '1' }}, Col 1</span><span class="status-divider"></span><span>{{ codeLength }} 字符</span></div>
          </div>
        </section>

        <aside class="assistant-panel">
          <div class="assistant-heading">
            <div class="assistant-title"><div class="assistant-icon"><WandSparkles :size="16" /></div><div><strong>AI 助手</strong><span>把你的想法变成代码</span></div></div>
            <span class="powered-by"><span class="powered-dot"></span>豆包</span>
          </div>
          <div class="prompt-area">
            <label for="prompt-input">描述你想构建什么</label>
            <textarea
              id="prompt-input"
              v-model="prompt"
              maxlength="8000"
              placeholder="例如：写一个带防抖功能的搜索框，支持异步请求和加载状态…"
              @keydown.ctrl.enter="generateCode"
              @keydown.meta.enter="generateCode"
            ></textarea>
            <div class="prompt-footer">
              <span class="prompt-hint"><span class="keyboard-key">⌘</span><span class="keyboard-key">↵</span> 生成</span>
              <span>{{ prompt.length }} / 8000</span>
            </div>
          </div>
          <div class="prompt-options">
            <span class="option-label">语言</span>
            <button class="option-select" type="button" @click="($refs.languageMenu as HTMLElement).hidden = !($refs.languageMenu as HTMLElement).hidden">
              <span class="language-dot"></span>{{ selectedLanguage.name }}<ChevronDown :size="13" />
            </button>
          </div>
          <p v-if="editorError" class="error-message" role="alert">{{ editorError }}</p>
          <button v-if="!isGenerating" class="generate-button" type="button" :disabled="!prompt.trim()" @click="generateCode">
            <Sparkles :size="16" /><span>生成代码</span><ArrowUp :size="15" class="generate-arrow" />
          </button>
          <button v-else class="generate-button stop-button" type="button" @click="stopGeneration">
            <LoaderCircle :size="15" class="spin" /><span>{{ hasReceivedContent ? '正在生成…' : '正在连接模型…' }}</span><Square :size="13" fill="currentColor" class="stop-icon" />
          </button>
          <div class="assistant-tip"><Sparkles :size="13" /><span>描述越具体，结果越符合你的预期</span></div>
          <div class="examples">
            <span class="examples-heading">试试这样问</span>
            <button type="button" @click="prompt = '创建一个带输入验证和错误提示的登录表单组件'">创建一个表单组件 <ArrowUp :size="12" /></button>
            <button type="button" @click="prompt = '写一个带缓存和错误重试的 API 请求工具'">实现一个 API 请求工具 <ArrowUp :size="12" /></button>
          </div>
        </aside>
      </main>
    </div>
  </div>
</template>
