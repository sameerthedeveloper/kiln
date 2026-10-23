import { settings } from './settings';

/** Natural-language → shell command via the Anthropic Messages API (key stays on this machine). */
export async function generateCommand(prompt: string, cwd: string): Promise<string> {
  if (!settings.apiKey) throw new Error('Add an Anthropic API key in Settings (⌘,) to use AI.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 400,
      system:
        'You translate requests into a single shell command for a macOS zsh terminal. ' +
        'Reply with ONLY the command: no markdown, no backticks, no explanation. Chain with && or pipes if needed. ' +
        `Current directory: ${cwd}.`,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);
  const data = await res.json();
  const text: string = (data.content?.[0]?.text ?? '').trim();
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}
