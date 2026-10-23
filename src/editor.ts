import { complete, gitInfo } from './api';
import { generateCommand } from './ai';
import { history } from './settings';
import { el, esc, toast } from './ui';

export interface EditorHost {
  cwd: () => string;
  submit: (cmd: string) => void;
  historySearch: () => void;
  clear: () => void;
}

const OPS = /^(\|\||&&|\||;|&|>>|>|<)$/;

function highlight(text: string): string {
  let out = '';
  let expectCmd = true;
  const re = /(\s+)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\|\||&&|>>|[|;&<>])|([^\s|;&<>"']+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [t, ws, str, op, word] = m;
    if (ws) out += esc(t);
    else if (str) { out += `<i class="tk-str">${esc(t)}</i>`; expectCmd = false; }
    else if (op) { out += `<i class="tk-op">${esc(t)}</i>`; if (OPS.test(t) && !/[<>]/.test(t)) expectCmd = true; }
    else if (word) {
      if (expectCmd && !/^\w+=/.test(word)) { out += `<i class="tk-cmd">${esc(t)}</i>`; expectCmd = false; }
      else if (word.startsWith('-')) out += `<i class="tk-flag">${esc(t)}</i>`;
      else if (word.startsWith('$')) out += `<i class="tk-var">${esc(t)}</i>`;
      else if (/^(~|\.{0,2}\/)|\//.test(word)) out += `<i class="tk-path">${esc(t)}</i>`;
      else out += esc(t);
    }
  }
  return out;
}

export class Editor {
  root = el('div', 'composer');
  private chips = el('div', 'chips');
  private box = el('div', 'editor');
  private mirror = el('div', 'mirror');
  private ta = el('textarea');
  private popup = el('div', 'complete');
  private cwdChip = el('span', 'chip cwd');
  private gitChip = el('span', 'chip git');
  private aiChip = el('span', 'chip ai', '<b>AI</b> ask in plain English');
  private ghost = '';
  private hIdx = -1;
  private draft = '';
  private items: { name: string; dir: boolean }[] = [];
  private cIdx = -1;
  private cStart = 0;
  private busy = false;

  constructor(private host: EditorHost) {
    this.ta.rows = 1;
    this.ta.spellcheck = false;
    this.ta.autocapitalize = 'off';
    this.ta.setAttribute('autocorrect', 'off');
    this.ta.placeholder = 'Run a command…   (# to ask AI)';
    const gutter = el('span', 'gutter', '❯');
    this.box.append(gutter, this.mirror, this.ta);
    this.chips.append(this.cwdChip, this.gitChip, this.aiChip);
    this.root.append(this.popup, this.chips, this.box);
    this.popup.hidden = true;
    this.aiChip.hidden = true;

    this.ta.addEventListener('input', () => { this.hIdx = -1; this.closePopup(); this.refresh(); });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('blur', () => setTimeout(() => this.closePopup(), 120));
    this.box.addEventListener('mousedown', (e) => { if (e.target !== this.ta) { e.preventDefault(); this.focus(); } });
    this.refresh();
  }

  focus() { this.ta.focus({ preventScroll: true }); }
  get value() { return this.ta.value; }
  set value(v: string) { this.ta.value = v; this.hIdx = -1; this.refresh(); this.ta.setSelectionRange(v.length, v.length); }
  insert(text: string) { this.value = text; this.focus(); }
  setDisabled(d: boolean, hint = '') {
    this.root.classList.toggle('busy', d);
    this.ta.disabled = d;
    this.ta.placeholder = d ? hint : 'Run a command…   (# to ask AI)';
  }

  setCwd(cwd: string, home: string) {
    this.cwdChip.innerHTML = `<svg viewBox="0 0 16 16"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>${esc(cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd)}`;
    void this.refreshGit(cwd);
  }
  async refreshGit(cwd: string) {
    const g = await gitInfo(cwd).catch(() => null);
    this.gitChip.hidden = !g;
    if (g) this.gitChip.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="6" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.6c0 2.4-3 2-7 3.4"/></svg>${esc(g.branch)}${g.dirty ? `<em>±${g.dirty}</em>` : ''}`;
  }

  private refresh() {
    const v = this.ta.value;
    const single = !v.includes('\n');
    this.ghost = '';
    if (v && single && !v.startsWith('#')) {
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.length > v.length && h.startsWith(v) && !h.includes('\n')) { this.ghost = h.slice(v.length); break; }
      }
    }
    this.mirror.innerHTML = (v.startsWith('#') ? `<i class="tk-ai">${esc(v)}</i>` : highlight(v)) + (this.ghost ? `<i class="ghost">${esc(this.ghost)}</i>` : '') + '\n';
    this.aiChip.hidden = !v.startsWith('#');
    this.root.classList.toggle('ai', v.startsWith('#'));
  }

  private caretAtEnd() { return this.ta.selectionStart === this.ta.value.length && this.ta.selectionEnd === this.ta.value.length; }

  private onKey(e: KeyboardEvent) {
    const v = this.ta.value;
    if (this.items.length && !this.popup.hidden) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { this.moveC(1); return e.preventDefault(); }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { this.moveC(-1); return e.preventDefault(); }
      if (e.key === 'Enter' && this.cIdx >= 0) { this.applyC(); return e.preventDefault(); }
      if (e.key === 'Escape') { this.closePopup(); return e.preventDefault(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      if (this.busy) return;
      const cmd = v.trim();
      if (!cmd) return;
      if (cmd.startsWith('#')) return void this.askAI(cmd.replace(/^#+\s*/, ''));
      this.value = '';
      this.host.submit(v.replace(/\s+$/, ''));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      void this.doComplete();
    } else if ((e.key === 'ArrowRight' || e.key === 'End' || (e.ctrlKey && e.key === 'e')) && this.ghost && this.caretAtEnd()) {
      e.preventDefault();
      this.value = v + this.ghost;
    } else if (e.key === 'ArrowUp' && !e.shiftKey && this.onFirstLine()) {
      e.preventDefault();
      this.navHistory(-1);
    } else if (e.key === 'ArrowDown' && !e.shiftKey && this.hIdx >= 0 && this.onLastLine()) {
      e.preventDefault();
      this.navHistory(1);
    } else if (e.ctrlKey && e.key === 'c') {
      if (v) { e.preventDefault(); this.value = ''; }
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      this.host.clear();
    } else if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      this.host.historySearch();
    } else if (e.ctrlKey && e.key === 'u') {
      e.preventDefault();
      const s = this.ta.selectionStart;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      this.ta.setRangeText('', ls, s, 'end');
      this.refresh();
    } else if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      const s = this.ta.selectionStart;
      const m = /\S*\s*$/.exec(v.slice(0, s));
      this.ta.setRangeText('', s - (m ? m[0].length : 0), s, 'end');
      this.refresh();
    } else if (e.key === 'Escape' && v) {
      this.value = '';
    }
  }

  private onFirstLine() { return !this.ta.value.slice(0, this.ta.selectionStart).includes('\n'); }
  private onLastLine() { return !this.ta.value.slice(this.ta.selectionEnd).includes('\n'); }

  private navHistory(dir: number) {
    if (!history.length) return;
    if (this.hIdx < 0) { if (dir > 0) return; this.draft = this.ta.value; this.hIdx = history.length; }
    this.hIdx = Math.min(history.length, Math.max(0, this.hIdx + dir));
    const v = this.hIdx >= history.length ? this.draft : history[this.hIdx];
    if (this.hIdx >= history.length) this.hIdx = -1;
    const keep = this.hIdx;
    this.value = v;
    this.hIdx = keep;
    this.ta.setSelectionRange(0, 0);
    if (dir > 0 || keep < 0) this.ta.setSelectionRange(v.length, v.length);
    else this.ta.setSelectionRange(v.length, v.length);
  }

  private async askAI(prompt: string) {
    this.busy = true;
    this.root.classList.add('thinking');
    try {
      const cmd = await generateCommand(prompt, this.host.cwd());
      this.value = cmd;
      toast('AI suggestion ready — review, then press Enter');
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      this.busy = false;
      this.root.classList.remove('thinking');
    }
  }

  /* ---- completion ---- */
  private async doComplete() {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const m = /(\S*)$/.exec(before)!;
    const token = m[1];
    const start = pos - token.length;
    const prior = before.slice(0, start).trimEnd();
    const first = prior === '' || /[|;&]$/.test(prior);
    const res = await complete(this.host.cwd(), token, first).catch(() => []);
    if (!res.length) return;
    if (res.length === 1) return this.applyCompletion(start, pos, res[0]);
    let p = res[0].name;
    for (const r of res) while (!r.name.startsWith(p)) p = p.slice(0, -1);
    if (p.length > token.length) {
      this.ta.setRangeText(p, start, pos, 'end');
      this.refresh();
    }
    this.showPopup(res, start);
  }

  private applyCompletion(start: number, end: number, c: { name: string; dir: boolean }) {
    const text = c.name.replace(/([ '"()&;$`\\!#*?[\]{}<>|])/g, '\\$1') + (c.dir ? '/' : ' ');
    this.ta.setRangeText(text, start, end, 'end');
    this.closePopup();
    this.refresh();
  }

  private showPopup(res: { name: string; dir: boolean }[], start: number) {
    this.items = res.slice(0, 60);
    this.cStart = start;
    this.cIdx = -1;
    this.popup.innerHTML = '';
    this.items.forEach((it, i) => {
      const row = el('div', 'c-row', `<span class="c-ico">${it.dir ? '▸' : '·'}</span>${esc(it.name.split('/').filter(Boolean).pop() ?? it.name)}${it.dir ? '/' : ''}`);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.cIdx = i; this.applyC(); });
      this.popup.appendChild(row);
    });
    this.popup.hidden = false;
  }
  private moveC(d: number) {
    this.cIdx = (this.cIdx + d + this.items.length) % this.items.length;
    [...this.popup.children].forEach((c, i) => c.classList.toggle('sel', i === this.cIdx));
    (this.popup.children[this.cIdx] as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
  private applyC() {
    const it = this.items[this.cIdx];
    if (it) this.applyCompletion(this.cStart, this.ta.selectionStart, it);
  }
  private closePopup() { this.popup.hidden = true; this.items = []; this.cIdx = -1; }
}
