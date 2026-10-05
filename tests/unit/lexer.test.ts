import { describe, expect, it } from 'vitest';
import { lexContent } from '../../src/pdf/lexer.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const ops = (s: string) => lexContent(enc(s)).map((o) => o.op);

describe('lexContent', () => {
  it('演算子とオペランドに分解する', () => {
    const result = lexContent(enc('q 1 0 0 1 10.5 -2 cm /Im1 Do Q'));
    expect(result.map((o) => o.op)).toEqual(['q', 'cm', 'Do', 'Q']);
    expect(result[1].operands).toEqual([1, 0, 0, 1, 10.5, -2].map((value) => ({ type: 'number', value })));
    expect(result[2].operands).toEqual([{ type: 'name', value: 'Im1' }]);
  });

  it('文字列(括弧の入れ子・エスケープ・8 進数)を読む', () => {
    const [tj] = lexContent(enc('(a\\(b\\)c (nested) \\101\\n) Tj'));
    const s = tj.operands[0];
    expect(s.type === 'string' && new TextDecoder().decode(s.bytes)).toBe('a(b)c (nested) A\n');
  });

  it('16 進文字列と配列(TJ)を読む', () => {
    const [tj] = lexContent(enc('[<0012 003A> -250 (x)] TJ'));
    expect(tj.op).toBe('TJ');
    const arr = tj.operands[0];
    expect(arr.type).toBe('array');
    if (arr.type !== 'array') return;
    expect(arr.items[0]).toEqual({ type: 'string', bytes: Uint8Array.from([0x00, 0x12, 0x00, 0x3a]), hex: true });
    expect(arr.items[1]).toEqual({ type: 'number', value: -250 });
  });

  it('文字列の中の演算子らしき語やコメント記号を誤認しない', () => {
    expect(ops('(Q q cm % not a comment) Tj % comment\nET')).toEqual(['Tj', 'ET']);
  });

  it('名前の #xx エスケープを戻す', () => {
    const [gs] = lexContent(enc('/A#20B gs'));
    expect(gs.operands[0]).toEqual({ type: 'name', value: 'A B' });
  });

  it('インライン画像のパラメータを読み、画像データは読み飛ばす', () => {
    const data = 'BI /W 4 /H 2 /CS /RGB /BPC 8 ID \x00Q q\xffEI\x01 EI Q';
    const result = lexContent(enc(data));
    expect(result.map((o) => o.op)).toEqual(['BI', 'Q']);
    expect(result[0].inlineImage?.get('W')).toEqual({ type: 'number', value: 4 });
    expect(result[0].inlineImage?.get('CS')).toEqual({ type: 'name', value: 'RGB' });
  });

  it('演算子の開始・終了位置を記録する(後で書き換えるため)', () => {
    const text = 'BT 12 0 Td (Hi) Tj ET';
    const tj = lexContent(enc(text)).find((o) => o.op === 'Tj')!;
    expect(text.slice(tj.start, tj.end)).toBe('(Hi) Tj');
  });

  it('dict のオペランド(マーク付きコンテンツ)を読む', () => {
    const [bdc] = lexContent(enc('/Span <</ActualText (x) /MCID 3>> BDC'));
    expect(bdc.op).toBe('BDC');
    const d = bdc.operands[1];
    expect(d.type === 'dict' && d.entries.get('MCID')).toEqual({ type: 'number', value: 3 });
  });
});
