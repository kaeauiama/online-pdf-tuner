// 文字のアウトライン化(D-034)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { wrapBareCff } from '../../src/pdf/glyphs.ts';
import { lexContent, num } from '../../src/pdf/lexer.ts';
import { outlineText } from '../../src/print/outline.ts';
import { pageContentBytes, streamBytes } from '../../src/print/structure.ts';
import { typoPdf } from './typoFixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const BIZ = new Uint8Array(readFileSync(join(ROOT, 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf')));
const CFF = new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', 'test-cff.otf')));

async function withText(fontBytes: Uint8Array | 'helvetica', content: (code: (t: string) => string) => string, edit?: (doc: PDFDocument, fontRef: PDFRef) => void) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 300]);
  const font = fontBytes === 'helvetica' ? await doc.embedFont(StandardFonts.Helvetica) : await doc.embedFont(fontBytes, { subset: true });
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  const text = content((t) => font.encodeText(t).toString());
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(text))));
  // 字形を確定させる(サブセットを書き出す)ために一度保存して読み直す
  const saved = await PDFDocument.load(await doc.save());
  edit?.(saved, saved.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F1')) as PDFRef);
  return new Uint8Array(await saved.save());
}

async function outlined(bytes: Uint8Array) {
  const result = await outlineText(bytes, 'all');
  const doc = await PDFDocument.load(result.bytes);
  const page = doc.getPage(0);
  const ops = lexContent(pageContentBytes(doc, page));
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const formOf = (name: string) => doc.context.lookup(xobjects.get(PDFName.of(name))) as PDFStream;
  return { result, doc, page, ops, formOf };
}

const cms = (ops: ReturnType<typeof lexContent>) => ops.filter((o) => o.op === 'cm').map((o) => o.operands.map(num));
const showOps = (ops: ReturnType<typeof lexContent>) => ops.filter((o) => ['Tj', 'TJ', "'", '"'].includes(o.op));

describe('outlineText: TrueType(Type0)', () => {
  it('文字を字形の図形に置き換え、フォントを資源から外す', async () => {
    const { result, ops, page, formOf } = await outlined(await withText(BIZ, (c) => `BT /F1 24 Tf 1 0 0 1 50 100 Tm ${c('講習会')} Tj ET`));
    expect(result.pages[0]).toMatchObject({ glyphs: 3, kept: [] });
    expect(showOps(ops)).toHaveLength(0);
    expect(ops.filter((o) => o.op === 'Do')).toHaveLength(3);
    expect(page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()).toHaveLength(0);
    // 1 字目: 文字の大きさ 24pt・原点 (50, 100)。BIZ UDPゴシックは 1em = 2048
    const [a, b, c, d, e, f] = cms(ops)[0];
    expect([a, b, c, d]).toEqual([expect.closeTo(24 / 2048, 6), 0, 0, expect.closeTo(24 / 2048, 6)]);
    expect([e, f]).toEqual([50, 100]);
    // 2 字目は 1 字目の字幅だけ右
    expect(cms(ops)[1][4]).toBeCloseTo(50 + 24, 1);
    const firstForm = ops.find((o) => o.op === 'Do')!;
    const form = formOf(firstForm.operands[0].type === 'name' ? firstForm.operands[0].value : '');
    expect(new TextDecoder().decode(streamBytes(form))).toMatch(/ m .* f$/);
  });

  it('単純な TrueType(WinAnsi)も、文字コード → Unicode → 字形で描く', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const ctx = doc.context;
    const file = ctx.register(ctx.flateStream(BIZ));
    const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'BIZUDPGothic', Flags: 32, FontFile2: file }));
    const font = ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'BIZUDPGothic', FirstChar: 65, LastChar: 66, Widths: [600, 600], Encoding: 'WinAnsiEncoding', FontDescriptor: descriptor }),
    );
    page.node.setFontDictionary(PDFName.of('F1'), font);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(new TextEncoder().encode('BT /F1 20 Tf 50 100 Td (AB) Tj ET'))));
    const { result, ops } = await outlined(new Uint8Array(await doc.save()));
    expect(result.pages[0]).toMatchObject({ glyphs: 2, kept: [] });
    expect(cms(ops)[1][4]).toBeCloseTo(50 + 12, 3);
  });

  it('同じ字形のフォームは共有する', async () => {
    const { ops, page } = await outlined(await withText(BIZ, (c) => `BT /F1 12 Tf 50 100 Td ${c('会会会')} Tj ET`));
    const names = new Set(ops.filter((o) => o.op === 'Do').map((o) => (o.operands[0].type === 'name' ? o.operands[0].value : '')));
    expect(names.size).toBe(1);
    expect(page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).keys()).toHaveLength(1);
  });

  it('見えない文字(描画モード 3)は削除し、線のモードは線で描く', async () => {
    const { result, ops } = await outlined(
      await withText(BIZ, (c) => `BT /F1 12 Tf 3 Tr 50 100 Td ${c('講習')} Tj ET
BT /F1 12 Tf 1 Tr 2 w 50 200 Td ${c('会')} Tj ET`),
    );
    expect(result.pages[0]).toMatchObject({ glyphs: 1, removedInvisible: 2 });
    const stroke = ops.find((o) => o.op === 'S');
    expect(stroke).toBeDefined();
    // 線の太さは字形の空間に直す: 2pt ÷ (12 / 2048)
    const w = ops.find((o) => o.op === 'w' && Math.abs(num(o.operands[0]) - 2) > 0.01)!;
    expect(num(w.operands[0])).toBeCloseTo(2 / (12 / 2048), 1);
  });

  it('縦書き(Identity-V): 字は下へ進み、字形の原点を中央上に合わせる', async () => {
    const bytes = await withText(BIZ, (c) => `BT /F1 20 Tf 1 0 0 1 200 250 Tm ${c('講習')} Tj ET`, (doc, ref) => {
      (doc.context.lookup(ref) as PDFDict).set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
    });
    const { ops } = await outlined(bytes);
    const [first, second] = cms(ops);
    // 既定の DW2 [880 -1000]: 原点は (字幅/2, 880)。字送りは -1em
    expect(first[5]).toBeCloseTo(250 - 0.88 * 20, 3);
    expect(second[5]).toBeCloseTo(250 - 20 - 0.88 * 20, 3);
    expect(first[4]).toBeLessThan(200);
  });

  it('フォーム XObject の中の文字も処理する', async () => {
    const doc = await PDFDocument.load(await withText(BIZ, (c) => `BT /F1 12 Tf 10 10 Td ${c('講')} Tj ET`));
    const page = doc.getPage(0);
    const res = page.node.Resources()!;
    const form = doc.context.flateStream(pageContentBytes(doc, page), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Resources: res });
    const formRef = doc.context.register(form);
    page.node.setXObject(PDFName.of('Fm1'), formRef);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode('q /Fm1 Do Q'))));
    const result = await outlineText(new Uint8Array(await doc.save()), 'all');
    expect(result.pages[0].glyphs).toBe(1);
    const out = await PDFDocument.load(result.bytes);
    const outForm = out.context.lookup(out.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).get(PDFName.of('Fm1'))) as PDFStream;
    expect(showOps(lexContent(streamBytes(outForm)))).toHaveLength(0);
  });
});

describe('outlineText: CFF', () => {
  it('CID の CFF(pdf-lib が埋め込む素の CIDFontType0C)の字形を、輪郭どおりに描く', async () => {
    const { result, ops, formOf } = await outlined(await withText(CFF, (c) => `BT /F1 10 Tf 1 0 0 1 100 200 Tm ${c('AB')} Tj ET`));
    expect(result.pages[0]).toMatchObject({ glyphs: 2, kept: [] });
    const [first] = cms(ops);
    expect(first).toEqual([expect.closeTo(0.01, 6), 0, 0, expect.closeTo(0.01, 6), 100, 200]);
    const name = ops.find((o) => o.op === 'Do')!.operands[0];
    const content = new TextDecoder().decode(streamBytes(formOf(name.type === 'name' ? name.value : '')));
    expect(content).toBe('100 0 m 500 0 l 500 700 l 100 700 l h f');
    // 2 字目は A の字幅(600)だけ右
    expect(cms(ops)[1][4]).toBeCloseTo(106, 3);
  });

  it('OpenType(FontFile3 /OpenType)の CFF も読める。穴のある字形は輪郭を 2 つ持つ', async () => {
    // 元の OpenType をそのまま入れる。CID は元のフォントの字形 ID(4 = あ)
    const bytes = await withText(CFF, () => 'BT /F1 10 Tf 100 200 Td <0004> Tj ET', (doc, ref) => {
      const type0 = doc.context.lookup(ref) as PDFDict;
      const cid = doc.context.lookup((type0.lookup(PDFName.of('DescendantFonts')) as unknown as { get(i: number): PDFRef }).get(0)) as PDFDict;
      cid.lookup(PDFName.of('FontDescriptor'), PDFDict).set(PDFName.of('FontFile3'), doc.context.register(doc.context.flateStream(CFF, { Subtype: 'OpenType' })));
    });
    const { result, formOf, ops } = await outlined(bytes);
    expect(result.pages[0]).toMatchObject({ glyphs: 1, kept: [] });
    const name = ops.find((o) => o.op === 'Do')!.operands[0];
    const content = new TextDecoder().decode(streamBytes(formOf(name.type === 'name' ? name.value : '')));
    expect(content.match(/ m /g)).toHaveLength(2);
  });

  it('wrapBareCff: 素の CFF を fontkit で読める OpenType にする', () => {
    const otf = wrapBareCff(new Uint8Array([1, 0, 4, 1]));
    expect(String.fromCharCode(...otf.subarray(0, 4))).toBe('OTTO');
    expect(new DataView(otf.buffer).getUint16(4)).toBe(5);
  });
});

describe('outlineText: 文字のまま残すもの', () => {
  it('埋め込まれていないフォントの塊は残し、理由を返す', async () => {
    const { result, ops } = await outlined(await withText('helvetica', (c) => `BT /F1 12 Tf 50 100 Td ${c('Hello')} Tj ET`));
    expect(result.pages[0].glyphs).toBe(0);
    expect(result.pages[0].kept).toEqual([expect.objectContaining({ reason: 'not-embedded' })]);
    expect(showOps(ops)).toHaveLength(1);
  });

  it('「埋め込み不可」のフォントは残す', async () => {
    const { result } = await outlined(new Uint8Array(await typoPdf(0x0002)));
    expect(result.pages[0].kept).toEqual([expect.objectContaining({ reason: 'restricted', font: 'TestMincho' })]);
  });

  it('クリップのモードの塊は残し、前の塊で設定した文字の状態を書き足す', async () => {
    const { ops, result } = await outlined(
      await withText(BIZ, (c) => `BT /F1 18 Tf 50 100 Td ${c('講')} Tj ET
BT 7 Tr 50 200 Td ${c('会')} Tj ET`),
    );
    expect(result.pages[0].glyphs).toBe(1);
    expect(result.pages[0].kept).toEqual([expect.objectContaining({ reason: 'clip' })]);
    // 残した塊の前に、フォントと大きさが書き足されている
    const tf = ops.filter((o) => o.op === 'Tf');
    expect(tf).toHaveLength(1);
    expect(num(tf[0].operands[1])).toBe(18);
  });
});
