export function buildMessages({ prompt, language }) {
  return [
    {
      role: 'system',
      content: [
        'You are a senior software engineer helping a developer write code.',
        'Return only the requested source code. Do not add markdown fences or prose.',
        'Use clear, maintainable, production-minded code and honor the requested language.',
        `The requested programming language is ${language}.`,
      ].join(' '),
    },
    {
      role: 'user',
      content: prompt,
    },
  ];
}
