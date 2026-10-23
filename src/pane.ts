import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { homeDir, ptyKill, ptyResize, ptySpawn, ptyWrite } from './api';
import { Editor } from './editor';
import { MarkerStream, type StreamEvent } from './stream';
import { pushHistory, settings } from './settings';
import { themeById, xtermTheme } from './themes';
import { copy, el, esc } from './ui';

interface Block {
  cmd: string;
  cwd: string;
  t0: number;
  dur?: number;
  exit: number | null;
  start?: IMarker;
  end?: IMarker;
  head?: IDecoration;
  stripe?: IDecoration;
  headEl?: HTMLElement;
}

type State = 'boot' | 'idle' | 'pre' | 'running';

const ICON = {
  cmd: '<svg viewBox="0 0 16 16"><path d="M3 3.5l5 4.5-5 4.5"/><path d="M9 13h4"/></svg>',
  out: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M5.5 6.5h5M5.5 9.5h3"/></svg>',
  rerun: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>',
};

export interface PaneEvents {
  focus: (p: Pane) => void;
  title: (p: Pane) => void;
  exit: (p: Pane) => void;
  historySearch: (p: Pane) => void;
}

/** Interactive CLI agents own the whole terminal; hide Kiln's input box while they run. */
const AGENT_CLIS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'agy', 'aider', 'opencode', 'amp', 'cursor-agent', 'copilot']);

export class Pane {
  el = el('div', 'pane');
  title = 'shell';
  cwd = '';
  home = '';
  state: State = 'boot';
  private id = 0;
  private term: Terminal;
  private fit = new FitAddon();
  readonly search = new SearchAddon();
  private termWrap = el('div', 'term-wrap');
  private welcome = el('div', 'welcome');
  private boot = el('div', 'boot', '<span class="spin"></span> starting shell…');
  private editor: Editor;
  private stream = new MarkerStream();
  private bootBuf: string[] = [];
  private passthrough = false;
  private blocks: Block[] = [];
  private cur?: Block;
  private pendingCmd = '';
  private tick = 0;
  private bootTimer = 0;
  private ro: ResizeObserver;
  private dead = false;

  constructor(private ev: PaneEvents, cwd?: string) {
    this.term = new Terminal({
      fontFamily: '"Space Mono", ui-monospace, Menlo, monospace',
      fontSize: settings.fontSize,
      lineHeight: 1.3,
      scrollback: 100000,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: xtermTheme(themeById(settings.theme)),
      overviewRuler: { width: 0 },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, '_blank')));

    this.editor = new Editor({
      cwd: () => this.cwd,
      submit: (c) => this.submit(c),
      historySearch: () => this.ev.historySearch(this),
      clear: () => this.clearBlocks(),
    });

    this.welcome.innerHTML = `
      <div class="w-mark"><span>KILN</span></div>
      <p>Every command gets its own block. Output stays with the command that made it.</p>
      <div class="w-grid">
        <div><kbd>⌘P</kbd>Command palette</div>
        <div><kbd>⌃R</kbd>Search history</div>
        <div><kbd>⌃⇧R</kbd>Workflows</div>
        <div><kbd>#</kbd>Ask AI for a command</div>
        <div><kbd>⌘D</kbd>Split pane</div>
        <div><kbd>⌘↑ ↓</kbd>Jump between blocks</div>
      </div>`;
    this.termWrap.append(this.welcome, this.boot);
    this.el.append(this.termWrap, this.editor.root);
    this.term.open(this.termWrap);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch { /* canvas/DOM fallback */ }

    this.editor.setDisabled(true, 'Starting shell…');
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (this.state === 'idle') && !e.metaKey && !(e.ctrlKey && e.key === 'c' && this.term.hasSelection())) {
        if (e.key.length === 1 || e.key === 'Enter') { this.editor.focus(); return false; }
      }
      if (e.metaKey && e.type === 'keydown' && e.key === 'c' && this.term.hasSelection()) { void copy(this.term.getSelection()); return false; }
      if (e.metaKey) return false; // app-level shortcuts
      return true;
    });
    this.term.onData((d) => { if (this.state === 'running' || this.state === 'pre' || this.passthrough) ptyWrite(this.id, d); });
    this.term.onBinary((d) => { if (this.id) ptyWrite(this.id, d); });
    this.term.onTitleChange((t) => { if (t) { this.title = t; this.ev.title(this); } });

    this.el.addEventListener('mousedown', () => this.ev.focus(this));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.termWrap);

    void this.start(cwd);
  }

  private async start(cwd?: string) {
    this.home = await homeDir();
    this.refit();
    this.id = await ptySpawn(this.term.cols, this.term.rows, cwd, (b) => this.onBytes(b));
    this.bootTimer = window.setTimeout(() => {
      if (this.state !== 'boot') return;
      this.passthrough = true;
      this.state = 'running';
      this.boot.remove();
      this.welcome.hidden = true;
      this.editor.root.hidden = true;
      this.bootBuf.forEach((s) => this.term.write(s));
      this.bootBuf = [];
      this.term.focus();
      ptyResize(this.id, this.term.cols, this.term.rows);
    }, 8000);
  }

  /* ---------- stream handling ---------- */
  private onBytes(b: Uint8Array) { this.handle(this.stream.push(b)); }

  private handle(events: StreamEvent[]) {
    for (const e of events) {
      switch (e.t) {
        case 'data':
          if (this.state === 'running') this.term.write(e.s);
          else if (this.state === 'boot') this.bootBuf.push(e.s);
          break;
        case 'cwd':
          this.cwd = e.path;
          this.editor.setCwd(e.path, this.home);
          if (this.state !== 'running') this.setTitleFromCwd();
          break;
        case 'A':
          if (this.state === 'boot') { clearTimeout(this.bootTimer); this.bootBuf = []; this.boot.remove(); }
          this.state = 'idle';
          this.editor.root.hidden = false;
          this.editor.setDisabled(false);
          this.editor.refreshGit(this.cwd);
          if (document.activeElement === document.body || this.el.contains(document.activeElement) || this.el.classList.contains('active')) this.editor.focus();
          break;
        case 'C':
          this.state = 'running';
          this.startBlock();
          break;
        case 'D':
          if (this.cur) this.endBlock(e.code);
          this.state = 'idle';
          this.editor.root.hidden = false;
          break;
      }
    }
  }

  private setTitleFromCwd() {
    const base = this.cwd === this.home ? '~' : this.cwd.split('/').filter(Boolean).pop() || '/';
    this.title = base;
    this.ev.title(this);
  }

  /* ---------- submit ---------- */
  submit(cmd: string) {
    if (cmd.trim() === 'clear') return this.clearBlocks();
    pushHistory(cmd);
    this.pendingCmd = cmd;
    this.state = 'pre';
    this.editor.setDisabled(true, 'Running — keys go to the program');
    this.editor.root.hidden = AGENT_CLIS.has(cmd.trim().split(/\s+/).find((w) => !w.includes('=')) ?? '');
    const payload = cmd.includes('\n') ? `\x1b[200~${cmd}\x1b[201~\r` : cmd + '\r';
    ptyWrite(this.id, payload);
    this.title = cmd.split(/\s+/)[0];
    this.ev.title(this);
    setTimeout(() => { if (this.state === 'pre' || this.state === 'running') this.term.focus(); }, 0);
  }

  runExternal(cmd: string) {
    if (this.state === 'idle') this.submit(cmd);
  }

  /* ---------- blocks ---------- */
  private startBlock() {
    const b: Block = { cmd: this.pendingCmd, cwd: this.cwd, t0: performance.now(), exit: null };
    this.pendingCmd = '';
    this.cur = b;
    this.blocks.push(b);
    this.welcome.hidden = true;
    this.term.write('\x1b[2K\r\n\x1b[2K\r\n', () => {
      b.start = this.term.registerMarker(-2);
      if (!b.start) return;
      b.head = this.term.registerDecoration({ marker: b.start, x: 0, width: this.term.cols, height: 2 });
      b.head?.onRender((node) => {
        if (b.headEl === node) return;
        b.headEl = node;
        node.className = 'blk-head running';
        node.innerHTML = `<div class="bh"><span class="bh-status"><span class="spin"></span></span><code class="bh-cmd">${esc(b.cmd.split('\n')[0])}${b.cmd.includes('\n') ? ' …' : ''}</code><span class="bh-meta"></span><span class="bh-actions">
          <button data-a="cmd" title="Copy command">${ICON.cmd}</button><button data-a="out" title="Copy output">${ICON.out}</button><button data-a="rerun" title="Re-run">${ICON.rerun}</button></span></div>`;
        node.addEventListener('mousedown', (ev) => ev.stopPropagation());
        node.addEventListener('click', (ev) => {
          const a = (ev.target as HTMLElement).closest('button')?.dataset.a;
          if (a === 'cmd') void copy(b.cmd, 'Command copied');
          else if (a === 'out') void copy(this.blockOutput(b), 'Output copied');
          else if (a === 'rerun') this.runExternal(b.cmd);
        });
        this.paintHead(b);
      });
    });
    this.tick = window.setInterval(() => this.paintHead(b), 250);
  }

  private paintHead(b: Block) {
    const n = b.headEl;
    if (!n) return;
    const dur = b.dur ?? performance.now() - b.t0;
    const d = dur < 1000 ? `${Math.round(dur)}ms` : dur < 60000 ? `${(dur / 1000).toFixed(1)}s` : `${Math.floor(dur / 60000)}m ${Math.round((dur % 60000) / 1000)}s`;
    const home = this.home;
    const cwd = b.cwd.startsWith(home) ? '~' + b.cwd.slice(home.length) : b.cwd;
    const meta = n.querySelector('.bh-meta');
    if (meta) meta.textContent = `${cwd} · ${d}`;
    if (b.exit !== null) {
      n.classList.remove('running');
      n.classList.toggle('fail', b.exit !== 0);
      const st = n.querySelector('.bh-status');
      if (st) st.innerHTML = b.exit === 0 ? '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>' : `<b>${b.exit}</b>`;
    }
  }

  private endBlock(code: number) {
    const b = this.cur!;
    this.cur = undefined;
    clearInterval(this.tick);
    b.exit = code;
    b.dur = performance.now() - b.t0;
    const fin = () => {
      b.end = this.term.registerMarker(0);
      this.paintHead(b);
      if (b.start && b.end && !b.start.isDisposed) {
        b.stripe?.dispose();
        b.stripe = this.term.registerDecoration({ marker: b.start, x: 0, width: this.term.cols, height: Math.max(2, b.end.line - b.start.line) });
        b.stripe?.onRender((n) => { n.className = 'blk-stripe ' + (b.exit === 0 ? 'ok' : 'err'); });
      }
    };
    this.term.write('\x1b[0m', () => {
      if (this.term.buffer.active.cursorX > 0) this.term.write('\r\n', fin);
      else fin();
    });
    this.editor.refreshGit(this.cwd);
  }

  private blockOutput(b: Block): string {
    if (!b.start || !b.end) return '';
    const buf = this.term.buffer.normal;
    const lines: string[] = [];
    for (let i = b.start.line + 2; i < b.end.line; i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      const t = l.translateToString(true);
      if (l.isWrapped && lines.length) lines[lines.length - 1] += t;
      else lines.push(t);
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  clearBlocks() {
    this.blocks.forEach((b) => { b.head?.dispose(); b.stripe?.dispose(); });
    this.blocks = [];
    this.term.clear();
    this.term.write('\x1b[2J\x1b[3J\x1b[H');
    this.welcome.hidden = false;
  }

  jumpBlock(dir: 1 | -1) {
    const top = this.term.buffer.active.viewportY;
    const starts = this.blocks.filter((b) => b.start && !b.start.isDisposed).map((b) => b.start!.line);
    const t = dir < 0 ? [...starts].reverse().find((l) => l < top) : starts.find((l) => l > top);
    if (t !== undefined) this.term.scrollToLine(t);
    else if (dir > 0) this.term.scrollToBottom();
  }

  /* ---------- misc ---------- */
  focus() {
    if (this.state === 'running' || this.state === 'pre' || this.passthrough) this.term.focus();
    else this.editor.focus();
  }
  insertCommand(c: string) { this.editor.insert(c); }
  get lastCommand() { return this.blocks[this.blocks.length - 1]?.cmd; }
  get running() { return this.state === 'running' || this.state === 'pre'; }

  setActive(a: boolean) { this.el.classList.toggle('active', a); }

  applySettings() {
    this.term.options.theme = xtermTheme(themeById(settings.theme));
    this.term.options.fontSize = settings.fontSize;
    this.refit();
  }

  refit() {
    if (this.dead || !this.termWrap.clientWidth) return;
    try {
      this.fit.fit();
      if (this.id) ptyResize(this.id, this.term.cols, this.term.rows);
    } catch { /* not laid out yet */ }
  }

  dispose() {
    this.dead = true;
    clearInterval(this.tick);
    clearTimeout(this.bootTimer);
    this.ro.disconnect();
    if (this.id) ptyKill(this.id);
    this.term.dispose();
    this.el.remove();
  }
  get ptyId() { return this.id; }
}
