export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function toast(msg: string, kind: 'info' | 'err' = 'info') {
  toastEl ??= document.body.appendChild(el('div', 'toast'));
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), 2600);
}

export const copy = (text: string, note = 'Copied') =>
  navigator.clipboard.writeText(text).then(() => toast(note), () => toast('Copy failed', 'err'));

/* ---------- fuzzy ---------- */
export function fuzzy(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0, score = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    run = i === ti ? run + 1 : 0;
    score += 1 + run * 2 + (i === 0 || ' /-_.'.includes(t[i - 1]) ? 3 : 0);
    ti = i + 1;
  }
  return score / (1 + t.length * 0.02);
}

/* ---------- modal + palette ---------- */
export interface Item { label: string; hint?: string; detail?: string; run: () => void }

let openLayer: { close: () => void } | null = null;

function layer(content: HTMLElement, onClose?: () => void) {
  openLayer?.close();
  const back = el('div', 'backdrop');
  back.appendChild(content);
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('in'));
  const close = () => {
    if (openLayer?.close !== close) return;
    openLayer = null;
    back.classList.remove('in');
    setTimeout(() => back.remove(), 120);
    onClose?.();
  };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  openLayer = { close };
  return close;
}
export const closeLayer = () => openLayer?.close();
export const layerOpen = () => !!openLayer;

export function openPalette(opts: { placeholder: string; items: Item[]; initial?: string; onClose?: () => void }) {
  const box = el('div', 'palette');
  const input = el('input', 'palette-input');
  input.placeholder = opts.placeholder;
  input.value = opts.initial ?? '';
  input.spellcheck = false;
  const list = el('div', 'palette-list');
  box.append(input, list);
  let sel = 0;
  let shown: Item[] = [];
  const close = layer(box, opts.onClose);

  const render = () => {
    const q = input.value.trim();
    shown = opts.items
      .map((it) => ({ it, s: fuzzy(q, it.label + ' ' + (it.detail ?? '')) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = '';
    shown.forEach((it, i) => {
      const row = el('div', 'p-row' + (i === sel ? ' sel' : ''));
      row.innerHTML = `<span class="p-label">${esc(it.label)}</span>${it.detail ? `<span class="p-detail">${esc(it.detail)}</span>` : ''}${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}`;
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
      row.addEventListener('click', () => pick(i));
      list.appendChild(row);
    });
    if (!shown.length) list.appendChild(el('div', 'p-empty', 'No matches'));
  };
  const mark = () => {
    [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i: number) => { const it = shown[i]; close(); it?.run(); };

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { sel = (sel + 1) % Math.max(1, shown.length); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { sel = (sel - 1 + shown.length) % Math.max(1, shown.length); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(sel); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  render();
  input.focus();
}

export function openForm(title: string, sub: string, fields: { name: string; label: string; def?: string }[], submitLabel: string, onSubmit: (v: Record<string, string>) => void, onClose?: () => void) {
  const box = el('form', 'modal');
  box.innerHTML = `<h2>${esc(title)}</h2><p class="sub">${esc(sub)}</p>`;
  const inputs: Record<string, HTMLInputElement> = {};
  for (const f of fields) {
    const row = el('label', 'field', `<span>${esc(f.label)}</span>`);
    const inp = el('input');
    inp.value = f.def ?? '';
    inp.spellcheck = false;
    inputs[f.name] = inp;
    row.appendChild(inp);
    box.appendChild(row);
  }
  const btn = el('button', 'btn primary', esc(submitLabel));
  btn.type = 'submit';
  box.appendChild(btn);
  const close = layer(box, onClose);
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
    close();
    onSubmit(v);
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  Object.values(inputs)[0]?.focus();
}

export function openCustomModal(build: (close: () => void) => HTMLElement, onClose?: () => void) {
  const holder = el('div');
  const close = layer(holder, onClose);
  const box = build(close);
  holder.replaceWith(box);
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
