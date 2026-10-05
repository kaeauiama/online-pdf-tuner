import { degrees, PDFDocument, PDFName, rgb, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { mmToPt, ptToMm, rectWidth } from '../../src/print/geometry.ts';
import { scanStructure } from '../../src/print/structure.ts';
import { makePng } from './png.ts';

async function reload(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save());
}

describe('scanStructure: 画像', () => {
  it('表示サイズから実効解像度を計算する', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(makePng(300, 150, [200, 30, 30]));
    const page = doc.addPage([mmToPt(148), mmToPt(210)]);
    // 300px を 1 インチ(72pt)幅で配置 → 300ppi。150px を 2 インチの高さで配置 → 75ppi
    page.drawImage(png, { x: 10, y: 10, width: 72, height: 144 });
    const [s] = scanStructure(await reload(doc));
    expect(s.images).toHaveLength(1);
    expect(s.images[0].pixelWidth).toBe(300);
    expect(s.images[0].dpi).toBeCloseTo(75, 0);
    expect(s.images[0].color).toBe('rgb');
    expect(s.images[0].bounds.x0).toBeCloseTo(10, 3);
    expect(rectWidth(s.images[0].bounds)).toBeCloseTo(72, 3);
  });

  it('フォーム XObject(ページの埋め込み)の中の画像も、行列を合成して計算する', async () => {
    const inner = await PDFDocument.create();
    const png = await inner.embedPng(makePng(144, 144, [0, 0, 0]));
    inner.addPage([200, 200]).drawImage(png, { x: 0, y: 0, width: 72, height: 72 }); // 144ppi
    const outer = await PDFDocument.create();
    const [embedded] = await outer.embedPdf(await inner.save());
    // 埋め込んだページを半分の大きさで描く → 画像は 36pt 角 → 288ppi
    outer.addPage([200, 200]).drawPage(embedded, { x: 0, y: 0, xScale: 0.5, yScale: 0.5 });
    const [s] = scanStructure(await reload(outer));
    expect(s.images).toHaveLength(1);
    expect(s.images[0].dpi).toBeCloseTo(288, 0);
  });
});

describe('scanStructure: フォント', () => {
  it('標準 14 フォント(埋め込みなし)を「埋め込まれていない」と判定する', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([200, 200]).drawText('Hello', { x: 10, y: 10, font, size: 12 });
    const [s] = scanStructure(await reload(doc));
    expect(s.fonts).toEqual([{ name: 'Helvetica', subtype: 'Type1', embedded: false }]);
  });

  it('FontDescriptor に FontFile2 があれば「埋め込み」と判定し、サブセット接頭辞を除いた名前を返す', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const fontFile = ctx.register(ctx.flateStream(new Uint8Array([0, 1, 0, 0])));
    const descriptor = ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+MeiryoUI', FontFile2: fontFile });
    const cid = ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'ABCDEF+MeiryoUI', FontDescriptor: ctx.register(descriptor) });
    const font = ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+MeiryoUI', Encoding: 'Identity-H', DescendantFonts: [ctx.register(cid)] });
    page.node.setFontDictionary(PDFName.of('F1'), ctx.register(font));
    const [s] = scanStructure(await reload(doc));
    expect(s.fonts).toEqual([{ name: 'MeiryoUI', subtype: 'Type0', embedded: true }]);
  });
});

describe('scanStructure: 色・透明・注釈・寸法', () => {
  it('RGB と CMYK とグレーの使用を数える', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0) });
    const { cmyk, grayscale } = await import('@cantoo/pdf-lib');
    page.drawRectangle({ x: 20, y: 0, width: 10, height: 10, color: cmyk(0, 0, 0, 1) });
    page.drawRectangle({ x: 40, y: 0, width: 10, height: 10, color: grayscale(0.5) });
    const [s] = scanStructure(await reload(doc));
    expect(s.colorUse.rgb).toBeGreaterThan(0);
    expect(s.colorUse.cmyk).toBeGreaterThan(0);
    expect(s.colorUse.gray).toBeGreaterThan(0);
  });

  it('不透明度 1 未満の図形を「透明効果あり」と判定する', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(0, 0, 1), opacity: 0.5 });
    const [s] = scanStructure(await reload(doc));
    expect(s.transparency).toBe(true);
  });

  it('不透明な図形だけなら透明効果なし', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(0, 0, 1) });
    const [s] = scanStructure(await reload(doc));
    expect(s.transparency).toBe(false);
  });

  it('注釈を種類ごとに数える(リンクは別扱い)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const annots = [
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }),
      ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 10, 10] }),
      ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 10, 10] }),
    ].map((a) => ctx.register(a));
    page.node.set(PDFName.of('Annots'), ctx.obj(annots));
    const [s] = scanStructure(await reload(doc));
    expect(s.annotations).toEqual({ links: 1, widgets: 0, others: 2 });
  });

  it('ページの寸法・回転・TrimBox を読む', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([mmToPt(154), mmToPt(216)]);
    page.setRotation(degrees(90));
    page.setTrimBox(mmToPt(3), mmToPt(3), mmToPt(148), mmToPt(210));
    const [s] = scanStructure(await reload(doc));
    expect(Math.round(ptToMm(rectWidth(s.mediaBox)))).toBe(154);
    expect(s.rotation).toBe(90);
    expect(s.trimBox && Math.round(ptToMm(rectWidth(s.trimBox)))).toBe(148);
    expect(s.bleedBox).toBeUndefined();
  });
});
