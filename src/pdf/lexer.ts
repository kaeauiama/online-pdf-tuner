// PDF のコンテンツストリーム(ページの描画命令)を、演算子とオペランドの列に分解する。
// 入稿チェック(画像の配置・色の使用)と、今後の誤植修正(S1)で使う。
// 各演算子には元のバイト位置(start/end)を残し、後で書き換えられるようにしている。

export type Operand =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'string'; bytes: Uint8Array; hex: boolean }
  | { type: 'array'; items: Operand[] }
  | { type: 'dict'; entries: Map<string, Operand> }
  | { type: 'bool'; value: boolean }
  | { type: 'null' };

export interface ContentOp {
  readonly op: string;
  readonly operands: Operand[];
  /** 最初のオペランド(なければ演算子)の開始位置 */
  readonly start: number;
  /** 演算子の直後の位置 */
  readonly end: number;
  /** BI ... ID ... EI のインライン画像のときのみ: 画像のパラメータ */
  readonly inlineImage?: Map<string, Operand>;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWhite = (c: number) => WHITESPACE.has(c);
const isRegular = (c: number) => !WHITESPACE.has(c) && !DELIMITERS.has(c);

class Reader {
  pos = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  peek(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  skipWhitespaceAndComments(): void {
    while (!this.done) {
      const c = this.peek();
      if (isWhite(c)) {
        this.pos++;
      } else if (c === 0x25 /* % */) {
        while (!this.done && this.peek() !== 0x0a && this.peek() !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  regularToken(): string {
    const start = this.pos;
    while (!this.done && isRegular(this.peek())) this.pos++;
    return latin1(this.bytes.subarray(start, this.pos));
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

type Token = { kind: 'operand'; value: Operand } | { kind: 'op'; value: string } | { kind: 'close'; value: string };

function readLiteralString(r: Reader): Operand {
  r.pos++; // (
  const out: number[] = [];
  let depth = 1;
  while (!r.done) {
    const c = r.bytes[r.pos++];
    if (c === 0x5c /* \ */) {
      const n = r.bytes[r.pos++];
      const simple: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
      if (n in simple) out.push(simple[n]);
      else if (n >= 0x30 && n <= 0x37) {
        let v = n - 0x30;
        for (let i = 0; i < 2 && r.peek() >= 0x30 && r.peek() <= 0x37; i++) v = v * 8 + (r.bytes[r.pos++] - 0x30);
        out.push(v & 0xff);
      } else if (n === 0x0d) {
        if (r.peek() === 0x0a) r.pos++; // 行継続
      } else if (n !== 0x0a) {
        out.push(n);
      }
    } else if (c === 0x28) {
      depth++;
      out.push(c);
    } else if (c === 0x29) {
      if (--depth === 0) break;
      out.push(c);
    } else {
      out.push(c);
    }
  }
  return { type: 'string', bytes: Uint8Array.from(out), hex: false };
}

function readHexString(r: Reader): Operand {
  r.pos++; // <
  const digits: number[] = [];
  while (!r.done && r.peek() !== 0x3e) {
    const c = r.bytes[r.pos++];
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v >= 0) digits.push(v);
  }
  r.pos++; // >
  if (digits.length % 2 === 1) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
  return { type: 'string', bytes: out, hex: true };
}

function readName(r: Reader): Operand {
  r.pos++; // /
  const raw = r.regularToken();
  return { type: 'name', value: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
}

function nextToken(r: Reader): Token | null {
  r.skipWhitespaceAndComments();
  if (r.done) return null;
  const c = r.peek();
  if (c === 0x28) return { kind: 'operand', value: readLiteralString(r) };
  if (c === 0x3c) {
    if (r.peek(1) === 0x3c) {
      r.pos += 2;
      return { kind: 'operand', value: readDict(r) };
    }
    return { kind: 'operand', value: readHexString(r) };
  }
  if (c === 0x2f) return { kind: 'operand', value: readName(r) };
  if (c === 0x5b) {
    r.pos++;
    return { kind: 'operand', value: readArray(r) };
  }
  if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
    r.pos += c === 0x3e && r.peek(1) === 0x3e ? 2 : 1;
    return { kind: 'close', value: String.fromCharCode(c) };
  }
  const word = r.regularToken();
  if (word === '') {
    r.pos++; // 想定外の文字は読み飛ばす
    return nextToken(r);
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { kind: 'operand', value: { type: 'number', value: Number(word) } };
  if (word === 'true' || word === 'false') return { kind: 'operand', value: { type: 'bool', value: word === 'true' } };
  if (word === 'null') return { kind: 'operand', value: { type: 'null' } };
  return { kind: 'op', value: word };
}

function readArray(r: Reader): Operand {
  const items: Operand[] = [];
  for (;;) {
    const t = nextToken(r);
    if (!t || (t.kind === 'close' && t.value === ']')) break;
    if (t.kind === 'operand') items.push(t.value);
  }
  return { type: 'array', items };
}

function readDict(r: Reader): Operand {
  const entries = new Map<string, Operand>();
  let key: string | null = null;
  for (;;) {
    const t = nextToken(r);
    if (!t || (t.kind === 'close' && t.value === '>')) break;
    if (t.kind !== 'operand') continue;
    if (key === null) {
      if (t.value.type === 'name') key = t.value.value;
    } else {
      entries.set(key, t.value);
      key = null;
    }
  }
  return { type: 'dict', entries };
}

/** BI の後: キーと値の組を ID まで読み、続く画像データを EI まで読み飛ばす */
function readInlineImage(r: Reader): Map<string, Operand> {
  const params = new Map<string, Operand>();
  let key: string | null = null;
  for (;;) {
    const t = nextToken(r);
    if (!t) return params;
    if (t.kind === 'op' && t.value === 'ID') break;
    if (t.kind !== 'operand') continue;
    if (key === null) {
      if (t.value.type === 'name') key = t.value.value;
    } else {
      params.set(key, t.value);
      key = null;
    }
  }
  r.pos++; // ID の直後の空白 1 文字
  // 画像データの終わり: 空白 + "EI" + (空白 or 終端)
  const b = r.bytes;
  for (let i = r.pos; i < b.length - 1; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === 0 || isWhite(b[i - 1])) && (i + 2 >= b.length || isWhite(b[i + 2]))) {
      r.pos = i + 2;
      return params;
    }
  }
  r.pos = b.length;
  return params;
}

export function lexContent(bytes: Uint8Array): ContentOp[] {
  const r = new Reader(bytes);
  const ops: ContentOp[] = [];
  let operands: Operand[] = [];
  let start = -1;
  for (;;) {
    r.skipWhitespaceAndComments();
    const tokenStart = r.pos;
    const t = nextToken(r);
    if (!t) break;
    if (t.kind === 'operand') {
      if (operands.length === 0) start = tokenStart;
      operands.push(t.value);
    } else if (t.kind === 'op') {
      const opStart = operands.length > 0 ? start : tokenStart;
      if (t.value === 'BI') {
        const inlineImage = readInlineImage(r);
        ops.push({ op: 'BI', operands: [], start: opStart, end: r.pos, inlineImage });
      } else {
        ops.push({ op: t.value, operands, start: opStart, end: r.pos });
      }
      operands = [];
    }
  }
  return ops;
}

export function num(o: Operand | undefined): number {
  return o?.type === 'number' ? o.value : 0;
}

export function name(o: Operand | undefined): string | undefined {
  return o?.type === 'name' ? o.value : undefined;
}
