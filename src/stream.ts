export type StreamEvent =
  | { t: 'data'; s: string }
  | { t: 'A' }
  | { t: 'C' }
  | { t: 'D'; code: number }
  | { t: 'cwd'; path: string };

const MARK = /\x1b\](133;[ACD](?:;[^\x07\x1b]*)?|1337;Cwd=[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Splits a raw PTY byte stream into text + shell-integration markers (OSC 133 / OSC 1337 Cwd). */
export class MarkerStream {
  private dec = new TextDecoder();
  private carry = '';

  push(bytes: Uint8Array): StreamEvent[] {
    let s = this.carry + this.dec.decode(bytes, { stream: true });
    this.carry = '';

    const i = s.lastIndexOf('\x1b');
    if (i >= 0) {
      const tail = s.slice(i);
      const open = tail === '\x1b' || (tail.startsWith('\x1b]') && !/\x07|\x1b\\/.test(tail));
      if (open && tail.length < 80) {
        this.carry = tail;
        s = s.slice(0, i);
      }
    }

    const out: StreamEvent[] = [];
    let last = 0;
    MARK.lastIndex = 0;
    for (let m = MARK.exec(s); m; m = MARK.exec(s)) {
      if (m.index > last) out.push({ t: 'data', s: s.slice(last, m.index) });
      last = m.index + m[0].length;
      const body = m[1];
      if (body.startsWith('1337;Cwd=')) out.push({ t: 'cwd', path: body.slice(9) });
      else if (body[4] === 'A') out.push({ t: 'A' });
      else if (body[4] === 'C') out.push({ t: 'C' });
      else out.push({ t: 'D', code: parseInt(body.slice(6), 10) || 0 });
    }
    if (last < s.length) out.push({ t: 'data', s: s.slice(last) });
    return out;
  }
}
