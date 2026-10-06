import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { parseToUnicode } from '../../src/pdf/cmap.ts';
import { permissionOf, readFsType } from '../../src/pdf/fonts.ts';
import { lexContent } from '../../src/pdf/lexer.ts';
import { serializeOp } from '../../src/pdf/serialize.ts';
import { applyTypos, findTypos, textRuns } from '../../src/typo/typo.ts';
import { fakeTrueType, typoPdf } from './typoFixture.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const EDITABLE = 0x0008;
const PREVIEW_PRINT = 0x0004;

async function load(fsType: number | undefined, content?: string) {
  return PDFDocument.load(await typoPdf(fsType, content));
}

const pageText = (doc: PDFDocument) =>
  textRuns(doc, doc.getPage(0))
    .runs.flatMap((r) => r.glyphs.map((g) => g.text))
    .join('');

describe('parseToUnicode', () => {
  it('bfchar・bfrange(文字列・配列)を読む', () => {
    const cmap = parseToUnicode(
      enc(`1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <8B1B> <0002> <D840DC0B> endbfchar
2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<3042> <3044>] endbfrange`),
    );
    expect(cmap.codeBytes).toBe(2);
    expect(cmap.toUnicode.get(1)).toBe('講');
    expect(cmap.toUnicode.get(2)).toBe('𠀋'); // サロゲートペア
    expect([0x10, 0x11, 0x12].map((c) => cmap.toUnicode.get(c))).toEqual(['A', 'B', 'C']);
    expect(cmap.toUnicode.get(0x21)).toBe('い');
  });
});

describe('fsType(埋め込みの許諾)', () => {
  it('OS/2 テーブルから読み、許諾の種類に分ける', () => {
    expect(readFsType(fakeTrueType(0x0008))).toBe(0x0008);
    expect(readFsType(fakeTrueType(undefined))).toBeUndefined();
    expect(permissionOf(0x0000)).toBe('editable');
    expect(permissionOf(0x0008)).toBe('editable');
    expect(permissionOf(0x0004)).toBe('preview-print');
    expect(permissionOf(0x0002)).toBe('restricted');
    // 複数のビットが立っていれば、最も制限の緩いもの
    expect(permissionOf(0x000c)).toBe('editable');
    expect(permissionOf(undefined)).toBe('unknown');
  });
});

describe('serializeOp', () => {
  it('書き戻した演算子を読み直すと、同じ内容になる(文字列は 16 進で書くので hex の印だけ変わる)', () => {
    const src = '[<0001> -120.5 (A\\)) <00FF>] TJ /F1#20x 9 Tf';
    const strip = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v, (k, x) => (k === 'hex' || k === 'start' || k === 'end' ? undefined : x instanceof Uint8Array ? [...x] : x)));
    const ops = lexContent(enc(src));
    const again = lexContent(enc(ops.map(serializeOp).join(' ')));
    expect(strip(again)).toEqual(strip(ops));
  });
});

describe('findTypos / applyTypos', () => {
  it('同じフォント内の字への置き換え: 置き換えて、文字として読み直せる', async () => {
    const doc = await load(EDITABLE);
    expect(pageText(doc)).toBe('講習回');
    const matches = findTypos(doc, [0], '回', '会');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ fixable: true, before: '講習', after: '', fontName: 'TestMincho' });
    expect(await applyTypos(doc, matches)).toBe(1);
    const reloaded = await PDFDocument.load(await doc.save());
    expect(pageText(reloaded)).toBe('講習会');
  });

  it('2 字以上の置き換えと、変えない字を含む置き換え', async () => {
    const doc = await load(EDITABLE);
    const matches = findTypos(doc, [0], '習回', '習会');
    expect(matches[0].fixable).toBe(true);
    await applyTypos(doc, matches);
    expect(pageText(await PDFDocument.load(await doc.save()))).toBe('講習会');
  });

  it('プレビューと印刷のみのフォントは直さない(TYPO_FONT_LICENSE)', async () => {
    const matches = findTypos(await load(PREVIEW_PRINT), [0], '回', '会');
    expect(matches[0]).toMatchObject({ fixable: false, reason: 'TYPO_FONT_LICENSE' });
  });

  it('許諾が読めないフォントは直さない(TYPO_FONT_LICENSE_UNKNOWN)', async () => {
    const matches = findTypos(await load(undefined), [0], '回', '会');
    expect(matches[0]).toMatchObject({ fixable: false, reason: 'TYPO_FONT_LICENSE_UNKNOWN' });
  });

  it('フォントにない字は直さない(TYPO_GLYPH_MISSING、足りない字を示す)', async () => {
    const matches = findTypos(await load(EDITABLE), [0], '回', '演');
    expect(matches[0]).toMatchObject({ fixable: false, reason: 'TYPO_GLYPH_MISSING', detail: '演' });
  });

  it('字幅が違う字には置き換えない(TYPO_WIDTH_MISMATCH)', async () => {
    const matches = findTypos(await load(EDITABLE), [0], '回', '案');
    expect(matches[0]).toMatchObject({ fixable: false, reason: 'TYPO_WIDTH_MISMATCH' });
  });

  it('字数が違う置き換えは扱わない(検索結果なし)', async () => {
    expect(findTypos(await load(EDITABLE), [0], '回', '会会')).toEqual([]);
  });

  it('TJ の中で字間調整をはさんでいても見つけ、調整の値はそのまま残す', async () => {
    const doc = await load(EDITABLE, '<00010002> -50 <0004>');
    const matches = findTypos(doc, [0], '習回', '習会');
    expect(matches[0].fixable).toBe(true);
    await applyTypos(doc, matches);
    const reloaded = await PDFDocument.load(await doc.save());
    expect(pageText(reloaded)).toBe('講習会');
    const { ops } = textRuns(reloaded, reloaded.getPage(0));
    const tj = ops.find((o) => o.op === 'TJ')!;
    const arr = tj.operands[0];
    expect(arr.type === 'array' && arr.items[1]).toEqual({ type: 'number', value: -50 });
  });
});
