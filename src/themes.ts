export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  ui: { bg: string; surface: string; surface2: string; line: string; fg: string; dim: string; accent: string; hi: string; ink: string; ok: string; err: string; warn: string; sh: string };
  ansi: string[]; // 16 colours
}

const MUTED = ['#2c2b28', '#c4553f', '#8aa65f', '#c9a04a', '#6f94b8', '#a47fa8', '#6aa6a0', '#cfc9ba', '#6b675d', '#dd7a62', '#a8c47e', '#e2bd6a', '#93b2d0', '#bf9cc3', '#8cc4be', '#efe9da'];

const T = (id: string, name: string, ui: Theme['ui'], ansi: string[] = MUTED): Theme => ({ id, name, dark: true, ui, ansi });

export const THEMES: Theme[] = [
  T('basalt', 'Basalt',
    { bg: '#1b1b19', surface: '#262623', surface2: '#34332f', line: '#a9a395', fg: '#d9d4c7', dim: '#8b8678', accent: '#c8553a', hi: '#c9b27a', ink: '#120d0a', ok: '#7f9c5a', err: '#b8422e', warn: '#c9a04a', sh: '#0b0b0a' }),
  T('rust', 'Rust',
    { bg: '#201512', surface: '#2c1d18', surface2: '#3c2921', line: '#b08a78', fg: '#e4d3c6', dim: '#977f70', accent: '#d2623a', hi: '#d9a15f', ink: '#150b07', ok: '#8a9a5a', err: '#c24a35', warn: '#d9a15f', sh: '#0d0807' }),
  T('slate', 'Slate',
    { bg: '#171a1d', surface: '#20252a', surface2: '#2d343b', line: '#94a0aa', fg: '#d3d9de', dim: '#7d8993', accent: '#6f94b8', hi: '#a9bccb', ink: '#0a0e12', ok: '#7fa383', err: '#bd5a52', warn: '#bfa05e', sh: '#08090b' }),
  T('peat', 'Peat',
    { bg: '#1a1913', surface: '#24231b', surface2: '#322f23', line: '#a39b7a', fg: '#dad4bd', dim: '#8a8368', accent: '#a8863c', hi: '#c4b36a', ink: '#14110a', ok: '#8a9f5a', err: '#b5503a', warn: '#c4a24a', sh: '#0a0a07' }),
  T('ash', 'Ash',
    { bg: '#161616', surface: '#202020', surface2: '#2e2e2e', line: '#9b9b9b', fg: '#d6d6d6', dim: '#808080', accent: '#cfcfcf', hi: '#b8b8b8', ink: '#101010', ok: '#8fa884', err: '#b86057', warn: '#b8a672', sh: '#080808' }),
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export function xtermTheme(t: Theme) {
  const a = t.ansi;
  return {
    background: t.ui.bg, foreground: t.ui.fg, cursor: t.ui.accent, cursorAccent: t.ui.ink,
    selectionBackground: t.ui.hi, selectionForeground: t.ui.ink,
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11], brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

export function applyThemeVars(t: Theme) {
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries(t.ui)) r.setProperty(`--${k}`, v);
  r.colorScheme = t.dark ? 'dark' : 'light';
}
