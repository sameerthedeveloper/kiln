import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isTauri = '__TAURI_INTERNALS__' in window;

export interface Completion { name: string; dir: boolean }
export interface GitInfo { branch: string; dirty: number }

type DataCb = (b: Uint8Array) => void;
const mocks = new Map<number, { cb: DataCb; buf: string; exit?: () => void }>();
let mockId = 0;

const enc = new TextEncoder();
const OSC = (s: string) => `\x1b]${s}\x07`;

/** Browser-only fake shell so the UI can be developed/tested without the Rust backend. */
function mockWrite(id: number, data: string) {
  const m = mocks.get(id);
  if (!m) return;
  const send = (s: string) => m.cb(enc.encode(s));
  if (data === '\x03') { send(OSC('133;D;130') + OSC('133;A')); return; }
  m.buf += data;
  if (!m.buf.includes('\r')) return;
  const cmd = m.buf.replace(/\x1b\[20[01]~/g, '').trim();
  m.buf = '';
  send(cmd + '\r\n' + OSC('133;C'));
  const [bin, ...args] = cmd.split(/\s+/);
  setTimeout(() => {
    if (bin === 'ls') send('\x1b[1;34msrc\x1b[0m  \x1b[1;34mnode_modules\x1b[0m  package.json  README.md\r\n');
    else if (bin === 'echo') send(args.join(' ') + '\r\n');
    else if (bin === 'fail') send('\x1b[31merror:\x1b[0m something broke\r\n');
    else if (bin === 'seq') { let o = ''; for (let i = 1; i <= +(args[0] || 10); i++) o += i + '\r\n'; send(o); }
    else send(`mock: ${cmd}\r\n`);
    send(OSC('133;D;' + (bin === 'fail' ? '1' : '0')) + OSC('1337;Cwd=/Users/demo/kiln') + OSC('133;A'));
  }, 120);
}

export async function ptySpawn(cols: number, rows: number, cwd: string | undefined, onData: DataCb): Promise<number> {
  if (!isTauri) {
    const id = ++mockId;
    mocks.set(id, { cb: onData, buf: '' });
    setTimeout(() => onData(enc.encode(OSC('1337;Cwd=/Users/demo/kiln') + OSC('133;A'))), 200);
    return id;
  }
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (b) => onData(new Uint8Array(b));
  return invoke<number>('pty_spawn', { cols, rows, cwd, onData: ch });
}

export const ptyWrite = (id: number, data: string) =>
  isTauri ? void invoke('pty_write', { id, data }) : mockWrite(id, data);
export const ptyResize = (id: number, cols: number, rows: number) =>
  isTauri ? void invoke('pty_resize', { id, cols, rows }) : undefined;
export const ptyKill = (id: number) => (isTauri ? void invoke('pty_kill', { id }) : void mocks.delete(id));

export const complete = (cwd: string, token: string, first: boolean): Promise<Completion[]> =>
  isTauri
    ? invoke('complete', { cwd, token, first })
    : Promise.resolve(['src/', 'package.json', 'README.md'].filter((n) => n.startsWith(token)).map((name) => ({ name, dir: name.endsWith('/') })));

export const gitInfo = (cwd: string): Promise<GitInfo | null> =>
  isTauri ? invoke('git_info', { cwd }) : Promise.resolve({ branch: 'main', dirty: 3 });

export const readShellHistory = (): Promise<string[]> =>
  isTauri ? invoke('read_shell_history') : Promise.resolve(['git status', 'npm run dev', 'ls -la']);

export const homeDir = (): Promise<string> => (isTauri ? invoke('home_dir') : Promise.resolve('/Users/demo'));

export function onPtyExit(cb: (id: number) => void) {
  if (isTauri) void listen<number>('pty-exit', (e) => cb(e.payload));
}

export async function startDrag() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().startDragging();
}
export async function closeWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}
