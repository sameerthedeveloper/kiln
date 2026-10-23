import { closeWindow, onPtyExit, readShellHistory, startDrag } from './api';
import { Pane } from './pane';
import { history, saveSettings, seedHistory, settings } from './settings';
import { THEMES, applyThemeVars, themeById } from './themes';
import { closeLayer, el, esc, layerOpen, openCustomModal, openForm, openPalette, toast, type Item } from './ui';
import { WORKFLOWS, fill, paramsOf } from './workflows';

type Node = { kind: 'leaf'; pane: Pane } | { kind: 'split'; dir: 'row' | 'col'; ratio: number; a: Node; b: Node };
interface Tab { id: number; root: Node; active: Pane; title: string }

const leaves = (n: Node): Pane[] => (n.kind === 'leaf' ? [n.pane] : [...leaves(n.a), ...leaves(n.b)]);

export class App {
  private tabs: Tab[] = [];
  private cur!: Tab;
  private nextTab = 1;
  private bar = el('div', 'titlebar');
  private tabsEl = el('div', 'tabs');
  private stage = el('div', 'stage');
  private side = el('aside', 'side');
  private barTitle = el('div');

  constructor(private root: HTMLElement) {
    applyThemeVars(themeById(settings.theme));
    const grow = el('div', 'bar-fill');
    const actions = el('div', 'bar-actions');
    const pal = el('button', 'icon-btn', '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h6"/></svg>');
    pal.title = 'Command palette (⌘P)';
    pal.onclick = () => this.palette();
    const set = el('button', 'icon-btn', '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg>');
    set.title = 'Settings (⌘,)';
    set.onclick = () => this.openSettings();
    const fold = el('button', 'icon-btn', '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h11v11h-11zM6.5 2.5v11"/></svg>');
    fold.title = 'Toggle sidebar (⌘B)';
    fold.onclick = () => this.toggleSide();
    actions.append(pal, set);
    this.barTitle.className = 'bar-title';
    this.bar.append(fold, this.barTitle, grow, actions);
    this.bar.addEventListener('mousedown', (e) => {
      if (e.target === this.bar || e.target === grow || e.target === this.barTitle) void startDrag();
    });

    const sideTop = el('div', 'side-top');
    sideTop.addEventListener('mousedown', () => void startDrag());
    const brand = el('div', 'side-brand', 'KILN');
    const add = el('button', 'side-new', '<span>+</span>New session');
    add.title = 'New session (⌘T)';
    add.onclick = () => this.newTab();
    this.side.append(sideTop, brand, add, this.tabsEl);
    const main = el('div', 'main');
    main.append(this.bar, this.stage);
    const shell = el('div', 'shell');
    shell.append(this.side, main);
    this.root.append(shell);

    onPtyExit((id) => {
      for (const t of this.tabs) for (const p of leaves(t.root)) if (p.ptyId === id) return this.closePane(t, p);
    });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('focus', () => this.cur?.active.focus());
    void readShellHistory().then(seedHistory).catch(() => {});

    this.newTab();
  }

  /* ---------- tabs & panes ---------- */
  private makePane(cwd?: string) {
    return new Pane({
      focus: (p) => this.setActive(p),
      title: (p) => this.onTitle(p),
      exit: (p) => this.closePane(this.tabOf(p)!, p),
      historySearch: (p) => this.historySearch(p),
    }, cwd);
  }
  private tabOf = (p: Pane) => this.tabs.find((t) => leaves(t.root).includes(p));

  newTab() {
    const pane = this.makePane(this.cur?.active.cwd || undefined);
    const tab: Tab = { id: this.nextTab++, root: { kind: 'leaf', pane }, active: pane, title: 'shell' };
    this.tabs.push(tab);
    this.select(tab);
  }

  private select(tab: Tab) {
    this.cur = tab;
    this.renderTabs();
    this.renderStage();
    requestAnimationFrame(() => tab.active.focus());
  }

  private setActive(p: Pane) {
    const t = this.tabOf(p);
    if (!t) return;
    t.active = p;
    leaves(t.root).forEach((l) => l.setActive(l === p && leaves(t.root).length > 1));
  }

  private onTitle(p: Pane) {
    const t = this.tabOf(p);
    if (!t) return;
    if (t.active === p) { t.title = p.title; this.renderTabs(); }
  }

  split(dir: 'row' | 'col') {
    const t = this.cur;
    const np = this.makePane(t.active.cwd || undefined);
    const swap = (n: Node): Node =>
      n.kind === 'leaf'
        ? n.pane === t.active ? { kind: 'split', dir, ratio: 0.5, a: n, b: { kind: 'leaf', pane: np } } : n
        : { ...n, a: swap(n.a), b: swap(n.b) };
    t.root = swap(t.root);
    t.active = np;
    this.renderStage();
    this.setActive(np);
    requestAnimationFrame(() => np.focus());
  }

  closePane(t: Tab, p: Pane) {
    const all = leaves(t.root);
    if (all.length === 1) return this.closeTab(t);
    const idx = all.indexOf(p);
    const strip = (n: Node): Node | null => {
      if (n.kind === 'leaf') return n.pane === p ? null : n;
      const a = strip(n.a), b = strip(n.b);
      if (!a) return b;
      if (!b) return a;
      return { ...n, a, b };
    };
    t.root = strip(t.root)!;
    p.dispose();
    const rest = leaves(t.root);
    t.active = rest[Math.min(idx, rest.length - 1)];
    if (t === this.cur) { this.renderStage(); this.setActive(t.active); t.active.focus(); }
  }

  closeTab(t: Tab) {
    leaves(t.root).forEach((p) => p.dispose());
    const i = this.tabs.indexOf(t);
    this.tabs.splice(i, 1);
    if (!this.tabs.length) return void closeWindow();
    if (t === this.cur) this.select(this.tabs[Math.max(0, i - 1)]);
    else this.renderTabs();
  }

  private renderTabs() {
    this.tabsEl.innerHTML = '';
    this.tabs.forEach((t, i) => {
      const run = leaves(t.root).some((p) => p.running);
      const n = leaves(t.root).length;
      const b = el('div', 'tab' + (t === this.cur ? ' on' : '') + (run ? ' run' : ''));
      const cwd = t.active.cwd;
      const home = t.active.home;
      const path = cwd ? (cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd) : '';
      b.innerHTML = `<span class="tab-n">${run ? '<i class="dot"></i>' : i + 1}</span><span class="tab-body"><span class="tab-t">${esc(t.title)}</span><span class="tab-p">${esc(path)}${n > 1 ? ` · ${n} panes` : ''}</span></span><button class="tab-x" title="Close session">×</button>`;
      b.onclick = () => this.select(t);
      (b.querySelector('.tab-x') as HTMLElement).onclick = (e) => { e.stopPropagation(); this.closeTab(t); };
      this.tabsEl.appendChild(b);
    });
    this.barTitle.textContent = this.cur?.title ?? '';
  }

  toggleSide() {
    this.side.classList.toggle('shut');
    setTimeout(() => leaves(this.cur.root).forEach((p) => p.refit()), 160);
  }

  private renderStage() {
    this.stage.replaceChildren();
    const build = (n: Node): HTMLElement => {
      if (n.kind === 'leaf') return n.pane.el;
      const box = el('div', 'split ' + n.dir);
      const a = build(n.a), b = build(n.b);
      a.style.flex = `${n.ratio} 1 0`;
      b.style.flex = `${1 - n.ratio} 1 0`;
      const g = el('div', 'gutter-h');
      g.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        g.classList.add('drag');
        const move = (ev: MouseEvent) => {
          const r = n.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
          n.ratio = Math.min(0.85, Math.max(0.15, r));
          a.style.flex = `${n.ratio} 1 0`;
          b.style.flex = `${1 - n.ratio} 1 0`;
        };
        const up = () => { g.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
        addEventListener('mousemove', move);
        addEventListener('mouseup', up);
      });
      box.append(a, g, b);
      return box;
    };
    this.stage.appendChild(build(this.cur.root));
    const all = leaves(this.cur.root);
    all.forEach((p) => p.setActive(p === this.cur.active && all.length > 1));
    requestAnimationFrame(() => all.forEach((p) => p.refit()));
  }

  /* ---------- keyboard ---------- */
  private onKey(e: KeyboardEvent) {
    if (layerOpen()) return;
    const cmd = e.metaKey, ctrl = e.ctrlKey, k = e.key;
    const act = () => { e.preventDefault(); e.stopPropagation(); };
    const pane = this.cur.active;
    if (cmd && !ctrl && !e.altKey) {
      if (k === 't') { act(); this.newTab(); }
      else if (k === 'w') { act(); this.closePane(this.cur, pane); }
      else if (k === 'd') { act(); this.split(e.shiftKey ? 'col' : 'row'); }
      else if (k === 'p') { act(); this.palette(); }
      else if (k === ',') { act(); this.openSettings(); }
      else if (k === 'b') { act(); this.toggleSide(); }
      else if (k === 'k') { act(); pane.clearBlocks(); }
      else if (k === 'ArrowUp') { act(); pane.jumpBlock(-1); }
      else if (k === 'ArrowDown') { act(); pane.jumpBlock(1); }
      else if (k === '=' || k === '+') { act(); this.font(1); }
      else if (k === '-') { act(); this.font(-1); }
      else if (k === '0') { act(); settings.fontSize = 13; this.applyAll(); }
      else if (/^[1-9]$/.test(k)) { act(); const t = this.tabs[+k - 1]; if (t) this.select(t); }
      else if ((k === '[' || k === ']' || k === '{' || k === '}') ) {
        act();
        const dir = k === '[' || k === '{' ? -1 : 1;
        if (e.shiftKey) this.select(this.tabs[(this.tabs.indexOf(this.cur) + dir + this.tabs.length) % this.tabs.length]);
        else this.focusPane(dir);
      }
    } else if (ctrl && e.shiftKey && (k === 'R' || k === 'r')) { act(); this.workflows(pane); }
    else if (ctrl && !cmd && !e.shiftKey && k === 'Tab') { act(); this.select(this.tabs[(this.tabs.indexOf(this.cur) + 1) % this.tabs.length]); }
  }

  private focusPane(dir: number) {
    const all = leaves(this.cur.root);
    const p = all[(all.indexOf(this.cur.active) + dir + all.length) % all.length];
    this.setActive(p);
    p.focus();
  }

  private font(d: number) {
    settings.fontSize = Math.min(24, Math.max(9, settings.fontSize + d));
    this.applyAll();
  }

  private applyAll() {
    saveSettings();
    applyThemeVars(themeById(settings.theme));
    this.tabs.forEach((t) => leaves(t.root).forEach((p) => p.applySettings()));
  }

  /* ---------- palettes ---------- */
  private restoreFocus = () => requestAnimationFrame(() => this.cur.active.focus());

  historySearch(p: Pane) {
    const seen = new Set<string>();
    const items: Item[] = [];
    for (let i = history.length - 1; i >= 0 && items.length < 800; i--) {
      const c = history[i];
      if (seen.has(c)) continue;
      seen.add(c);
      items.push({ label: c.split('\n')[0], run: () => p.insertCommand(c) });
    }
    openPalette({ placeholder: 'Search command history…', items, onClose: this.restoreFocus });
  }

  workflows(p: Pane) {
    const items: Item[] = WORKFLOWS.map((w) => ({
      label: w.name,
      detail: w.command,
      hint: w.desc,
      run: () => {
        const params = paramsOf(w.command);
        if (!params.length) return p.insertCommand(w.command);
        openForm(w.name, w.command, params.map((n) => ({ name: n, label: n })), 'Insert command', (v) => p.insertCommand(fill(w.command, v)), this.restoreFocus);
      },
    }));
    openPalette({ placeholder: 'Workflows — saved, parameterised commands…', items, onClose: this.restoreFocus });
  }

  palette() {
    const pane = this.cur.active;
    const items: Item[] = [
      { label: 'New session', hint: '⌘T', run: () => this.newTab() },
      { label: 'Split pane right', hint: '⌘D', run: () => this.split('row') },
      { label: 'Split pane down', hint: '⇧⌘D', run: () => this.split('col') },
      { label: 'Close pane', hint: '⌘W', run: () => this.closePane(this.cur, pane) },
      { label: 'Clear blocks', hint: '⌘K', run: () => pane.clearBlocks() },
      { label: 'Search command history', hint: '⌃R', run: () => this.historySearch(pane) },
      { label: 'Open workflows', hint: '⌃⇧R', run: () => this.workflows(pane) },
      { label: 'Settings', hint: '⌘,', run: () => this.openSettings() },
      { label: 'Toggle sidebar', hint: '⌘B', run: () => this.toggleSide() },
      { label: 'Increase font size', hint: '⌘+', run: () => this.font(1) },
      { label: 'Decrease font size', hint: '⌘−', run: () => this.font(-1) },
      ...THEMES.map((t) => ({ label: `Theme: ${t.name}`, run: () => { settings.theme = t.id; this.applyAll(); } })),
    ];
    openPalette({ placeholder: 'Type a command…', items, onClose: this.restoreFocus });
  }

  openSettings() {
    openCustomModal((close) => {
      const box = el('div', 'modal settings');
      box.innerHTML = `<h2>Settings</h2><p class="sub">Everything stays on this machine.</p><h3>Theme</h3><div class="themes"></div>
        <h3>Font size</h3><div class="stepper"><button data-d="-1">−</button><b>${settings.fontSize}</b><button data-d="1">+</button></div>
        <h3>AI commands</h3><label class="field"><span>Anthropic API key</span><input type="password" id="k" placeholder="sk-ant-…" value="${esc(settings.apiKey)}" spellcheck="false"/></label>
        <label class="field"><span>Model</span><input id="m" value="${esc(settings.model)}" spellcheck="false"/></label>
        <button class="btn primary" id="done">Done</button>`;
      const grid = box.querySelector('.themes')!;
      const paint = () => {
        grid.innerHTML = '';
        for (const t of THEMES) {
          const c = el('button', 'theme' + (t.id === settings.theme ? ' on' : ''));
          c.innerHTML = `<span class="sw" style="background:${t.ui.bg};border-color:${t.ui.line}"><i style="background:${t.ui.accent}"></i><i style="background:${t.ui.ok}"></i><i style="background:${t.ui.err}"></i></span>${esc(t.name)}`;
          c.onclick = () => { settings.theme = t.id; this.applyAll(); paint(); };
          grid.appendChild(c);
        }
      };
      paint();
      box.querySelectorAll<HTMLElement>('.stepper button').forEach((b) => {
        b.onclick = () => { this.font(+b.dataset.d!); box.querySelector('.stepper b')!.textContent = String(settings.fontSize); };
      });
      (box.querySelector('#done') as HTMLElement).onclick = () => close();
      return box;
    }, () => {
      const root = this.stage.ownerDocument;
      settings.apiKey = (root.querySelector('#k') as HTMLInputElement | null)?.value.trim() ?? settings.apiKey;
      settings.model = (root.querySelector('#m') as HTMLInputElement | null)?.value.trim() || settings.model;
      saveSettings();
      this.restoreFocus();
    });
  }
}

export { closeLayer, toast };
