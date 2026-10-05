// ToUnicode CMap(字形番号 → 文字)の解析。誤植修正(S1)で、PDF の中の文字を探す・置き換えるのに使う。
import { lexContent, type Operand } from './lexer.ts';

export interface ToUnicodeMap {
  /** 字形番号(コード)のバイト数 */
  readonly codeBytes: number;
  readonly toUnicode: ReadonlyMap<number, string>;
}

function codeOf(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

/** UTF-16BE のバイト列を文字列にする(サロゲートペアもそのまま扱える) */
export function utf16be(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

const strings = (operands: Operand[]) => operands.filter((o): o is Extract<Operand, { type: 'string' }> => o.type === 'string');

export function parseToUnicode(data: Uint8Array): ToUnicodeMap {
  const map = new Map<number, string>();
  let codeBytes = 0;
  for (const op of lexContent(data)) {
    if (op.op === 'endcodespacerange') {
      const first = strings(op.operands)[0];
      if (first && codeBytes === 0) codeBytes = first.bytes.length;
    } else if (op.op === 'endbfchar') {
      const s = strings(op.operands);
      for (let i = 0; i + 1 < s.length; i += 2) {
        map.set(codeOf(s[i].bytes), utf16be(s[i + 1].bytes));
        if (codeBytes === 0) codeBytes = s[i].bytes.length;
      }
    } else if (op.op === 'endbfrange') {
      const o = op.operands;
      for (let i = 0; i + 2 < o.length; i += 3) {
        const lo = o[i];
        const hi = o[i + 1];
        const dst = o[i + 2];
        if (lo.type !== 'string' || hi.type !== 'string') continue;
        if (codeBytes === 0) codeBytes = lo.bytes.length;
        const from = codeOf(lo.bytes);
        const to = codeOf(hi.bytes);
        if (dst.type === 'array') {
          dst.items.forEach((d, k) => d.type === 'string' && map.set(from + k, utf16be(d.bytes)));
        } else if (dst.type === 'string') {
          // 範囲の各コードに、最後の 1 文字を順に増やした文字を割り当てる
          const base = utf16be(dst.bytes);
          const head = base.slice(0, -1);
          const last = base.charCodeAt(base.length - 1);
          for (let c = from; c <= to && c - from < 65536; c++) map.set(c, head + String.fromCharCode(last + (c - from)));
        }
      }
    }
  }
  return { codeBytes: codeBytes || 2, toUnicode: map };
}
