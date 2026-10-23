export interface Settings {
  theme: string;
  fontSize: number;
  apiKey: string;
  model: string;
}

const KEY = 'kiln.settings';
const DEFAULTS: Settings = { theme: 'basalt', fontSize: 13, apiKey: '', model: 'claude-haiku-5-5' };

export const settings: Settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
})();

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

const HKEY = 'kiln.history';
export const history: string[] = (() => {
  try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; }
})();

export function pushHistory(cmd: string) {
  if (history[history.length - 1] === cmd) return;
  history.push(cmd);
  if (history.length > 5000) history.splice(0, history.length - 5000);
  try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch { /* ignore */ }
}

export function seedHistory(cmds: string[]) {
  if (history.length) return;
  for (const c of cmds) if (history[history.length - 1] !== c) history.push(c);
  try { localStorage.setItem(HKEY, JSON.stringify(history)); } catch { /* ignore */ }
}
