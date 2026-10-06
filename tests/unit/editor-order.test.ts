// ページ内の編集: 重なり順の入れ替え(order.ts)と、ほかの変更との組み合わせ(edit.ts)
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyElementEdits, type ElementEdit } from '../../src/editor/edit.ts';
import { extractElements, type PageElement } from '../../src/editor/elements.ts';
import { analyzeLayering, moveInOrder, orderLimits } from '../../src/editor/order.ts';
import { lexContent } from '../../src/pdf/lexer.ts';
import { pageContentBytes } from '../../src/print/structure.ts';
import { makePng } from './png.ts';

async function pageWith(content: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const img = await doc.embedPng(makePng(20, 20, 'noise'));
  page.node.setXObject(PDFName.of('Im1'), img.ref);
  page.node.setExtGState(PDFName.of('Half'), doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: 0.4 })));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  return PDFDocument.load(await doc.save());
}

const square = (x: number) => `q 1 0 0 rg ${x} 0 10 10 re f Q`;
const solo = (id: number) => id;
const layeringOf = (doc: PDFDocument) => {
  const content = pageContentBytes(doc, doc.getPage(0));
  const elements = extractElements(doc, doc.getPage(0));
  return { content, elements, layering: analyzeLayering(lexContent(content), elements) };
};

async function rewrite(doc: PDFDocument, elements: PageElement[], order: number[], edits = new Map<number, ElementEdit>()) {
  const page = doc.getPage(0);
  const next = applyElementEdits(pageContentBytes(doc, page), elements, edits, order);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  const out = await PDFDocument.load(await doc.save());
  return { doc: out, elements: extractElements(out, out.getPage(0)), text: new TextDecoder().decode(pageContentBytes(out, out.getPage(0))) };
}

const xs = (els: readonly PageElement[]) => els.map((e) => Math.round(e.bounds.x0));

describe('analyzeLayering', () => {
  it('同じ親に並ぶ q 〜 Q は 1 つの一続きになり、入れ替えられる', async () => {
    const doc = await pageWith([square(0), square(20), square(40)].join('\n'));
    const { layering } = layeringOf(doc);
    expect(layering.runs).toEqual([[0, 1, 2]]);
    expect(orderLimits([0, 1, 2], layering, solo, 0)).toEqual({ reorderable: true, forward: true, backward: false });
  });

  it('間に状態を変える命令(色など)があると、そこで区切る', async () => {
    const doc = await pageWith([square(0), square(20), '0 0 1 rg', square(40)].join('\n'));
    const { layering } = layeringOf(doc);
    expect(layering.runs).toEqual([[0, 1], [2]]);
    expect(orderLimits([0, 1, 2], layering, solo, 1)).toMatchObject({ reorderable: true, forward: false });
    // ひとりだけの一続きは入れ替えられない
    expect(orderLimits([0, 1, 2], layering, solo, 2).reorderable).toBe(false);
  });

  it('q で囲まれていない描画と、BT の中の q 〜 Q は入れ替えの対象にしない', async () => {
    const doc = await pageWith([square(0), '0 0 1 rg 20 0 10 10 re f', square(40)].join('\n'));
    const { layering } = layeringOf(doc);
    expect(layering.runOf.size).toBe(0);
  });

  it('透明度などを外側の q 〜 Q で設定していれば、その外側ごと一つの単位にする', async () => {
    const doc = await pageWith(`q /Half gs q 20 0 0 20 0 0 cm /Im1 Do Q Q\n${square(40)}`);
    const { layering, elements } = layeringOf(doc);
    expect(elements[0].transparent).toBe(true);
    expect(layering.runs).toEqual([[0, 1]]);
    expect(layering.unitOf.get(0)).toMatchObject({ first: 0 });
  });
});

describe('moveInOrder と書き換え', () => {
  it('最前面へ・前面へ・背面へ・最背面へ', async () => {
    const doc = await pageWith([square(0), square(20), square(40), square(60)].join('\n'));
    const { layering } = layeringOf(doc);
    const order = [0, 1, 2, 3];
    expect(moveInOrder(order, layering, solo, 0, 'front')).toEqual([1, 2, 3, 0]);
    expect(moveInOrder(order, layering, solo, 1, 'forward')).toEqual([0, 2, 1, 3]);
    expect(moveInOrder(order, layering, solo, 2, 'backward')).toEqual([0, 2, 1, 3]);
    expect(moveInOrder(order, layering, solo, 3, 'back')).toEqual([3, 0, 1, 2]);
    expect(moveInOrder(order, layering, solo, 3, 'forward')).toBeNull();
    expect(moveInOrder(order, layering, solo, 0, 'back')).toBeNull();
  });

  it('入れ替えた順番で描画されるように書き換える', async () => {
    const doc = await pageWith([square(0), square(20), square(40)].join('\n'));
    const { layering, elements } = layeringOf(doc);
    const order = moveInOrder([0, 1, 2], layering, solo, 0, 'front')!;
    const after = await rewrite(doc, elements, order);
    expect(xs(after.elements)).toEqual([20, 40, 0]);
  });

  it('タグ付き PDF のマーク(BDC 〜 EMC)は、中身と一緒に動く', async () => {
    const doc = await pageWith(`/P <</MCID 0>> BDC ${square(0)} EMC\n/Figure <</MCID 1>> BDC ${square(20)} EMC`);
    const { layering, elements } = layeringOf(doc);
    const after = await rewrite(doc, elements, moveInOrder([0, 1], layering, solo, 0, 'front')!);
    expect(xs(after.elements)).toEqual([20, 0]);
    expect(after.text.indexOf('/MCID 1')).toBeLessThan(after.text.indexOf('/MCID 0'));
    expect(after.text.match(/BDC/g)).toHaveLength(2);
    expect(after.text.match(/EMC/g)).toHaveLength(2);
  });

  it('効果(影)は本体と一緒に動く', async () => {
    // 影(半透明の画像)+ 本体の画像 + 図形
    const doc = await pageWith(`q /Half gs 22 0 0 22 1 99 cm /Im1 Do Q
q 20 0 0 20 0 100 cm /Im1 Do Q
${square(200)}`);
    const { layering, elements } = layeringOf(doc);
    expect(elements[0].effectOf).toBe(1);
    const itemOf = (id: number) => elements[id].effectOf ?? id;
    const order = moveInOrder([0, 1, 2], layering, itemOf, 2, 'back')!;
    expect(order).toEqual([2, 0, 1]);
    const after = await rewrite(doc, elements, order);
    expect(xs(after.elements)).toEqual([200, 1, 0]);
    expect(after.elements[1].transparent).toBe(true);
  });

  it('入れ替えと同時に、動かす要素の移動・削除も反映する', async () => {
    const doc = await pageWith([square(0), square(20), square(40)].join('\n'));
    const { layering, elements } = layeringOf(doc);
    const order = moveInOrder([0, 1, 2], layering, solo, 0, 'front')!;
    const edits = new Map<number, ElementEdit>([
      [0, { kind: 'transform', dx: 100, dy: 0, scale: 1, anchor: [5, 5] }],
      [1, { kind: 'delete' }],
    ]);
    const after = await rewrite(doc, elements, order, edits);
    expect(xs(after.elements)).toEqual([40, 100]);
  });
});
