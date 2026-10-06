// コンテンツストリームのオペランドを書き戻す(誤植修正で、書き換えた演算子を元の位置に戻すため)。
import type { ContentOp, Operand } from './lexer.ts';

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function formatName(name: string): string {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    const regular = c > 0x20 && c < 0x7f && !'()<>[]{}/%#'.includes(ch);
    out += regular ? ch : `#${c.toString(16).padStart(2, '0')}`;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return `<${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;
}

export function serializeOperand(o: Operand): string {
  switch (o.type) {
    case 'number':
      return formatNumber(o.value);
    case 'name':
      return formatName(o.value);
    case 'string':
      return hex(o.bytes);
    case 'array':
      return `[${o.items.map(serializeOperand).join(' ')}]`;
    case 'dict':
      return `<<${[...o.entries].map(([k, v]) => `${formatName(k)} ${serializeOperand(v)}`).join(' ')}>>`;
    case 'bool':
      return o.value ? 'true' : 'false';
    case 'null':
      return 'null';
  }
}

export function serializeOp(op: Pick<ContentOp, 'op' | 'operands'>): string {
  return [...op.operands.map(serializeOperand), op.op].join(' ');
}

/** 置き換え: 書き出した命令(ASCII)か、元のコンテンツから切り出したバイト列(画像などの 2 進データを含みうる) */
export type Splice = { readonly start: number; readonly end: number } & ({ readonly text: string } | { readonly bytes: Uint8Array });

/** bytes の [start, end) を、それぞれ置き換える(位置の後ろから順に適用) */
export function spliceAll(bytes: Uint8Array, edits: readonly Splice[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const e of sorted) {
    const insert = 'bytes' in e ? e.bytes : new TextEncoder().encode(e.text); // オペランドは ASCII のみで書き出すので、そのまま
    const next = new Uint8Array(out.length - (e.end - e.start) + insert.length);
    next.set(out.subarray(0, e.start), 0);
    next.set(insert, e.start);
    next.set(out.subarray(e.end), e.start + insert.length);
    out = next;
  }
  return out;
}
