import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFName, rgb } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyElementEdits, localTransform, pageTransform, type ElementEdit } from '../../src/editor/edit.ts';
import { elementLabel, extractElements, type PageElement } from '../../src/editor/elements.ts';
import { applyToPoint, multiply, rectWidth, type Matrix, type Rect } from '../../src/print/geometry.ts';
import { pageContentBytes } from '../../src/print/structure.ts';
import { makePng } from './png.ts';

const FONT = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf'));
const round = (r: Rect) => [r.x0, r.y0, r.x1, r.y1].map((v) => Math.round(v));

/** 画像 1 枚(Im1)と、F1(BIZ UDPゴシック)を資源に持ち、コンテンツを直接書いたページ */
async function pageWith(content: string, opts: { gs?: Record<string, { ca?: number; CA?: number }> } = {}): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 600]);
  const img = await doc.embedPng(makePng(100, 50, 'noise'));
  page.node.setXObject(PDFName.of('Im1'), img.ref);
  const font = await doc.embedFont(FONT, { subset: true });
  font.encodeText('講習会ABC'); // サブセットに字を入れる
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  for (const [name, v] of Object.entries(opts.gs ?? {})) {
    page.node.setExtGState(PDFName.of(name), doc.context.register(doc.context.obj({ Type: 'ExtGState', ...v })));
  }
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  return PDFDocument.load(await doc.save());
}

const elementsOf = (doc: PDFDocument) => extractElements(doc, doc.getPage(0));

async function edited(doc: PDFDocument, edits: Map<number, ElementEdit>): Promise<PDFDocument> {
  const page = doc.getPage(0);
  const next = applyElementEdits(pageContentBytes(doc, page), elementsOf(doc), edits);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  return PDFDocument.load(await doc.save());
}

describe('extractElements: 種類と範囲', () => {
  it('q 〜 Q ごとに、図形・画像・文字を描画の順に取り出す', async () => {
    const doc = await pageWith(`
q 1 0 0 rg 10 20 100 50 re f Q
q 200 0 0 100 50 300 cm /Im1 Do Q
q BT /F1 20 Tf 1 0 0 1 60 500 Tm (\\000\\000) Tj ET Q`);
    const els = elementsOf(doc);
    expect(els.map((e) => e.kind)).toEqual(['path', 'image', 'text']);
    expect(round(els[0].bounds)).toEqual([10, 20, 110, 70]);
    expect(round(els[1].bounds)).toEqual([50, 300, 250, 400]);
    expect(els[1].events[0].pixels).toMatchObject({ width: 100, height: 50, dpi: 36 });
    expect(els.every((e) => e.movable)).toBe(true);
  });

  it('文字の範囲は、フォントの字幅と大きさから求める', async () => {
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const font = await src.embedFont(FONT, { subset: true });
    src.addPage([400, 600]).drawText('講習会', { x: 50, y: 100, size: 20, font, color: rgb(0, 0, 0) });
    const doc = await PDFDocument.load(await src.save());
    const [t] = elementsOf(doc);
    expect(t.kind).toBe('text');
    expect(t.bounds.x0).toBeCloseTo(50, 0);
    expect(rectWidth(t.bounds)).toBeCloseTo(font.widthOfTextAtSize('講習会', 20), 0);
    expect(t.bounds.y0).toBeLessThan(100);
    expect(t.bounds.y1).toBeGreaterThan(110);
    expect(elementLabel(t)).toBe('文字「講習会」');
  });

  it('クリップで切り抜かれた画像は、見えている範囲を返す', async () => {
    const doc = await pageWith('q 50 300 100 100 re W n 200 0 0 100 50 300 cm /Im1 Do Q');
    expect(round(elementsOf(doc)[0].bounds)).toEqual([50, 300, 150, 400]);
  });

  it('上下反転の CTM の中でも、ページ座標で範囲を返す', async () => {
    const doc = await pageWith('q 1 0 0 -1 0 600 cm q 200 0 0 100 50 100 cm /Im1 Do Q Q');
    // 反転後の y: 600 - 100 = 500 から 600 - 200 = 400
    expect(round(elementsOf(doc)[0].bounds)).toEqual([50, 400, 250, 500]);
  });

  it('q 〜 Q の中に別の要素が入れ子になっていれば、外側の要素は動かせない', async () => {
    const doc = await pageWith('q 0 0 1 rg 0 0 50 50 re f q 1 0 0 rg 100 100 50 50 re f Q Q');
    const els = elementsOf(doc);
    expect(els).toHaveLength(2);
    expect(els[0].movable).toBe(false);
    expect(els[1].movable).toBe(true);
  });
});

describe('relate: 効果と見えない文字', () => {
  it('半透明の画像のすぐ後に、ほぼ重なる不透明な要素があれば、その効果(影など)とみなす', async () => {
    const doc = await pageWith(
      `q /Half gs 205 0 0 105 53 297 cm /Im1 Do Q
q 200 0 0 100 50 300 cm /Im1 Do Q`,
      { gs: { Half: { ca: 0.4 } } },
    );
    const [shadow, main] = elementsOf(doc);
    expect(shadow.transparent).toBe(true);
    expect(shadow.effectOf).toBe(main.id);
    expect(main.effectOf).toBeUndefined();
  });

  it('画像に重なる完全に透明な文字は、その画像に重ねた検索用の文字とみなす', async () => {
    const doc = await pageWith(
      `q 200 0 0 100 50 300 cm /Im1 Do Q
q BT /F1 30 Tf 2 Tr /Clear gs 1 0 0 1 60 330 Tm <00010002> Tj ET Q`,
      { gs: { Clear: { ca: 0, CA: 0 } } },
    );
    const [image, text] = elementsOf(doc);
    expect(text.invisible).toBe(true);
    expect(text.overlayOf).toBe(image.id);
  });

  it('離れた位置の半透明の要素は関連づけない', async () => {
    const doc = await pageWith(
      `q /Half gs 0 0 1 rg 300 500 50 50 re f Q
q 200 0 0 100 50 100 cm /Im1 Do Q`,
      { gs: { Half: { ca: 0.5 } } },
    );
    expect(elementsOf(doc)[0].effectOf).toBeUndefined();
  });
});

describe('編集の書き換え', () => {
  it('localTransform: CTM の座標系に直した cm を差し込むと、ページ座標で M だけ動く', () => {
    const ctm: Matrix = [1, 0, 0, -1, 0, 600];
    const m = pageTransform({ kind: 'transform', dx: 10, dy: 20, scale: 1, anchor: [0, 0] });
    const local = localTransform(ctm, m);
    const p: [number, number] = [50, 100];
    const before = applyToPoint(ctm, ...p);
    const after = applyToPoint(multiply(local, ctm), ...p);
    expect(after[0] - before[0]).toBeCloseTo(10, 6);
    expect(after[1] - before[1]).toBeCloseTo(20, 6);
  });

  it('画像を動かす(上下反転の CTM の中でも、ページ座標で指定どおりに動く)', async () => {
    const doc = await pageWith('q 1 0 0 -1 0 600 cm q 200 0 0 100 50 100 cm /Im1 Do Q Q');
    const [img] = elementsOf(doc);
    const moved = await edited(doc, new Map([[img.id, { kind: 'transform', dx: 30, dy: -40, scale: 1, anchor: [img.bounds.x0, img.bounds.y0] }]]));
    expect(round(elementsOf(moved)[0].bounds)).toEqual([80, 360, 280, 460]);
  });

  it('拡大縮小は、指定した点を中心に縦横同じ率で行う', async () => {
    const doc = await pageWith('q 200 0 0 100 50 300 cm /Im1 Do Q');
    const [img] = elementsOf(doc);
    const scaled = await edited(doc, new Map([[img.id, { kind: 'transform', dx: 0, dy: 0, scale: 0.5, anchor: [50, 300] }]]));
    expect(round(elementsOf(scaled)[0].bounds)).toEqual([50, 300, 150, 350]);
  });

  it('削除: q 〜 Q ごと取り除き、ほかの要素はそのまま', async () => {
    const doc = await pageWith(`q 1 0 0 rg 10 20 100 50 re f Q
q 200 0 0 100 50 300 cm /Im1 Do Q`);
    const els = elementsOf(doc);
    const rest = elementsOf(await edited(doc, new Map([[els[0].id, { kind: 'delete' }]])));
    expect(rest.map((e) => e.kind)).toEqual(['image']);
    expect(round(rest[0].bounds)).toEqual(round(els[1].bounds));
  });

  it('動かせない要素(入れ子の外側)への移動は無視し、削除は描画の命令だけを消す', async () => {
    const doc = await pageWith('q 0 0 1 rg 0 0 50 50 re f q 1 0 0 rg 100 100 50 50 re f Q Q');
    const [outer, inner] = elementsOf(doc);
    const same = await edited(doc, new Map([[outer.id, { kind: 'transform', dx: 10, dy: 10, scale: 1, anchor: [0, 0] }]]));
    expect(round(elementsOf(same)[0].bounds)).toEqual(round(outer.bounds));
    const deleted = elementsOf(await edited(doc, new Map([[outer.id, { kind: 'delete' }]])));
    expect(deleted).toHaveLength(1);
    expect(round(deleted[0].bounds)).toEqual(round(inner.bounds));
  });

  it('効果と本体を、同じ中心で一緒に動かせる', async () => {
    const doc = await pageWith(
      `q /Half gs 205 0 0 105 53 297 cm /Im1 Do Q
q 200 0 0 100 50 300 cm /Im1 Do Q`,
      { gs: { Half: { ca: 0.4 } } },
    );
    const [shadow, main] = elementsOf(doc);
    const anchor: [number, number] = [main.bounds.x0, main.bounds.y0];
    const edit: ElementEdit = { kind: 'transform', dx: 20, dy: 10, scale: 1, anchor };
    const after = elementsOf(await edited(doc, new Map<number, ElementEdit>([[shadow.id, edit], [main.id, edit]])));
    expect(after[0].bounds.x0 - shadow.bounds.x0).toBeCloseTo(20, 3);
    expect(after[1].bounds.y0 - main.bounds.y0).toBeCloseTo(10, 3);
    expect(after[0].effectOf).toBe(after[1].id);
  });
});

export type { PageElement };
