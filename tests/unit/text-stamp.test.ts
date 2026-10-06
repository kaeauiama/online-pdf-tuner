import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { degrees, PDFDocument, type PDFFont } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { lexContent, num } from '../../src/pdf/lexer.ts';
import { mmToPt, ptToMm } from '../../src/print/geometry.ts';
import { pageContentBytes } from '../../src/print/structure.ts';
import { displayToUser, missingChars, PAGE_NUMBER_FORMATS, planPageNumbers, stampText, type StampSpec } from '../../src/text/stamp.ts';
import { textRuns } from '../../src/typo/typo.ts';

const FONT = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf'));

async function setup(rotation = 0): Promise<{ doc: PDFDocument; font: PDFFont }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([mmToPt(148), mmToPt(210)]);
  if (rotation) page.setRotation(degrees(rotation));
  const font = await doc.embedFont(FONT, { subset: true });
  return { doc, font };
}

/** 描いた文字の位置(Tm の e, f)と向き(a, b)を読む */
async function placements(doc: PDFDocument) {
  const saved = await PDFDocument.load(await doc.save());
  return lexContent(pageContentBytes(saved, saved.getPage(0)))
    .filter((o) => o.op === 'Tm')
    .map((o) => ({ a: num(o.operands[0]), b: num(o.operands[1]), x: ptToMm(num(o.operands[4])), y: ptToMm(num(o.operands[5])) }));
}

const spec = (over: Partial<StampSpec> = {}): StampSpec => ({ sizePt: 10, color: 'black', anchor: 'bottom-center', marginMm: { x: 0, y: 8 }, ...over });

describe('displayToUser(画面上の位置 → ページ座標)', () => {
  const box = { x: 0, y: 0, width: 100, height: 200 };
  it.each([
    [0, [10, 20]],
    [90, [80, 10]],
    [180, [90, 180]],
    [270, [20, 190]],
  ])('回転 %i', (r, expected) => {
    expect(displayToUser(box, r as number, 10, 20)).toEqual(expected);
  });
});

describe('stampText', () => {
  it('下中央: 横方向は中央、下の端から 8mm(字の下端)', async () => {
    const { doc, font } = await setup();
    stampText(doc.getPage(0), font, spec(), '12', 0);
    const [p] = await placements(doc);
    const w = ptToMm(font.widthOfTextAtSize('12', 10));
    expect(p.x).toBeCloseTo((148 - w) / 2, 1);
    const descent = ptToMm(font.heightAtSize(10) - font.heightAtSize(10, { descender: false }));
    expect(p.y).toBeCloseTo(8 + descent, 1);
    expect([p.a, p.b]).toEqual([1, 0]);
  });

  it('右上: 右と上の端から指定の距離', async () => {
    const { doc, font } = await setup();
    stampText(doc.getPage(0), font, spec({ anchor: 'top-right', marginMm: { x: 10, y: 10 } }), '見本', 0);
    const [p] = await placements(doc);
    const w = ptToMm(font.widthOfTextAtSize('見本', 10));
    expect(p.x + w).toBeCloseTo(148 - 10, 1);
    const ascent = ptToMm(font.heightAtSize(10, { descender: false }));
    expect(p.y + ascent).toBeCloseTo(210 - 10, 1);
  });

  it('複数行は行ごとに描き、下へ送る', async () => {
    const { doc, font } = await setup();
    stampText(doc.getPage(0), font, spec({ anchor: 'top-left', marginMm: { x: 10, y: 10 } }), '一行目\n二行目', 0);
    const ps = await placements(doc);
    expect(ps).toHaveLength(2);
    expect(ps[0].x).toBeCloseTo(10, 1);
    expect(ps[0].y - ps[1].y).toBeCloseTo(ptToMm(10 * 1.4), 1);
  });

  it('回転したページ(90°)では、画面上の下中央に、画面上で読める向きで描く', async () => {
    const { doc, font } = await setup(90);
    stampText(doc.getPage(0), font, spec(), '5', 90);
    const [p] = await placements(doc);
    // 回転 90° の画面上の「下」は、ページ座標の右端(x = 148mm)側
    expect(p.x).toBeGreaterThan(148 - 8 - 5);
    expect(p.x).toBeLessThan(148);
    // 画面上の横方向の中央 = ページ座標の縦方向の中央付近
    expect(p.y).toBeGreaterThan(100);
    expect(p.y).toBeLessThan(110);
    // 文字の向き: 反時計回りに 90°(画面で回転して、横書きに見える)
    expect(p.a).toBeCloseTo(0, 5);
    expect(p.b).toBeCloseTo(1, 5);
  });

  it('TrimBox があれば、仕上がり位置を基準にする', async () => {
    const { doc, font } = await setup();
    const page = doc.getPage(0);
    page.setTrimBox(mmToPt(3), mmToPt(3), mmToPt(142), mmToPt(204));
    stampText(page, font, spec({ anchor: 'bottom-left', marginMm: { x: 5, y: 8 } }), 'A', 0);
    const [p] = await placements(doc);
    expect(p.x).toBeCloseTo(3 + 5, 1);
  });

  it('文字として読み出せる(日本語・機種依存文字)', async () => {
    const { doc, font } = await setup();
    stampText(doc.getPage(0), font, spec(), '稽古のご案内 ①', 0);
    const saved = await PDFDocument.load(await doc.save());
    const text = textRuns(saved, saved.getPage(0)).runs.flatMap((r) => r.glyphs.map((g) => g.text)).join('');
    expect(text).toBe('稽古のご案内 ①');
  });

  it('色は CMYK(黒は K100)で書く', async () => {
    const { doc, font } = await setup();
    stampText(doc.getPage(0), font, spec(), '1', 0);
    const saved = await PDFDocument.load(await doc.save());
    const k = lexContent(pageContentBytes(saved, saved.getPage(0))).find((o) => o.op === 'k');
    expect(k?.operands.map(num)).toEqual([0, 0, 0, 1]);
  });
});

describe('missingChars', () => {
  it('フォント(CP932 の範囲)にない字を返す', async () => {
    const { font } = await setup();
    expect(missingChars(font, '稽古①\n案内')).toEqual([]);
    expect(missingChars(font, '𠮷野家')).toEqual(['𠮷']);
  });
});

describe('ページ番号', () => {
  it('先頭を飛ばして、指定の番号から振る', () => {
    const { numbers, last } = planPageNumbers(5, 1, 1);
    expect([...numbers]).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(last).toBe(4);
  });

  it('書式', () => {
    expect(PAGE_NUMBER_FORMATS.plain.format(3, 8)).toBe('3');
    expect(PAGE_NUMBER_FORMATS.dash.format(3, 8)).toBe('- 3 -');
    expect(PAGE_NUMBER_FORMATS.slash.format(3, 8)).toBe('3 / 8');
    expect(PAGE_NUMBER_FORMATS.p.format(3, 8)).toBe('p. 3');
  });
});
