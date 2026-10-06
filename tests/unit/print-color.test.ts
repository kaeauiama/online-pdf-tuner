// 色の調整(D-035): RGB のまま / 黒を K100 / CMYK に変換、白のオーバープリントの解除
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { loadFunction } from '../../src/pdf/functions.ts';
import { lexContent } from '../../src/pdf/lexer.ts';
import { grayToCmyk, rgbToCmyk, vectorRgbToCmyk } from '../../src/print/cmyk.ts';
import { CMYK_LUT_GRID } from '../../src/print/cmykLut.ts';
import { adjustColors, unfilterPng, type ColorMode } from '../../src/print/colorConvert.ts';
import { pageContentBytes, scanStructure, streamBytes } from '../../src/print/structure.ts';

const FONT = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf'));

async function pdf(content: (code: (t: string) => string) => string, setup?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(FONT, { subset: true });
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.setExtGState(PDFName.of('OP'), doc.context.register(doc.context.obj({ Type: 'ExtGState', OP: true, op: true })));
  setup?.(doc);
  const text = content((t) => font.encodeText(t).toString());
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(text))));
  return doc.save();
}

async function run(bytes: Uint8Array, mode: ColorMode, fixWhiteOverprint = false) {
  const result = await adjustColors(bytes, { mode, fixWhiteOverprint });
  const doc = await PDFDocument.load(result.bytes);
  const ops = lexContent(pageContentBytes(doc, doc.getPage(0)));
  return { result, doc, ops, text: ops.map((o) => `${o.operands.map((x) => (x.type === 'number' ? Math.round(x.value * 100) / 100 : x.type === 'name' ? `/${x.value}` : '…')).join(' ')} ${o.op}`.trim()) };
}

describe('変換表(cmyk.ts)', () => {
  it('白はインキなし。無彩色の文字・線は K だけ。総インキ量は 350% 以内', () => {
    expect(rgbToCmyk(1, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(vectorRgbToCmyk(0, 0, 0)).toEqual([0, 0, 0, 1]);
    expect(vectorRgbToCmyk(0.5, 0.5, 0.5)).toEqual([0, 0, 0, 0.5]);
    expect(grayToCmyk(0.25)).toEqual([0, 0, 0, 0.75]);
    const red = rgbToCmyk(1, 0, 0);
    expect(red[1]).toBeGreaterThan(0.85);
    expect(red[2]).toBeGreaterThan(0.9);
    expect(red[0]).toBeLessThan(0.05);
    for (let i = 0; i <= 10; i++) {
      const c = rgbToCmyk(i / 10, (10 - i) / 20, 0.1);
      expect(c.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(3.5);
    }
    expect(CMYK_LUT_GRID).toBe(33);
  });

  it('格子点の間は滑らかに補間する', () => {
    const a = rgbToCmyk(0.5, 0.2, 0.1);
    const b = rgbToCmyk(0.501, 0.2, 0.1);
    a.forEach((v, k) => expect(Math.abs(v - b[k])).toBeLessThan(0.01));
  });
});

describe('関数の評価(functions.ts)', () => {
  it('型 2・3・0・4', async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const f2 = loadFunction(doc, ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 1], C1: [1, 0, 0], N: 1 }))!;
    expect(f2([0.25])).toEqual([0.25, 0, 0.75]);
    const f3 = loadFunction(doc, ctx.obj({ FunctionType: 3, Domain: [0, 1], Bounds: [0.5], Encode: [0, 1, 0, 1], Functions: [ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 }), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 })] }))!;
    expect(f3([0.25])[0]).toBeCloseTo(0.5);
    expect(f3([0.75])[0]).toBeCloseTo(0.5);
    const f0 = loadFunction(doc, ctx.stream(new Uint8Array([0, 255]), { FunctionType: 0, Domain: [0, 1], Range: [0, 1], Size: [2], BitsPerSample: 8 }))!;
    expect(f0([0.5])[0]).toBeCloseTo(0.5, 2);
    const f4 = loadFunction(doc, ctx.stream(new TextEncoder().encode('{ dup 0.5 gt { 1 sub } { 2 mul } ifelse 0 exch }'), { FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1] }))!;
    expect(f4([0.25])).toEqual([0, 0.5]);
    expect(f4([0.75])).toEqual([0, 0]);
  });
});

describe('黒を K100 に', () => {
  it('文字・線・図形の無彩色の RGB を K だけにする。有彩色はそのまま', async () => {
    const { text } = await run(await pdf(() => '0 0 0 rg 0.5 0.5 0.5 RG 1 0 0 rg'), 'k100');
    expect(text).toEqual(['0 0 0 1 k', '0 0 0 0.5 K', '1 0 0 rg']);
  });

  it('色空間で指定した色: K にした後の有彩色は、元の色空間を指定し直す', async () => {
    const bytes = await pdf(
      () => '/CS0 cs 0 0 0 sc 10 10 50 50 re f 1 0 0 sc 100 10 50 50 re f',
      (doc) => {
        const cs = doc.context.obj({});
        cs.set(PDFName.of('CS0'), doc.context.obj([PDFName.of('ICCBased'), doc.context.register(doc.context.stream(new Uint8Array(4), { N: 3 }))]));
        doc.getPage(0).node.Resources()!.set(PDFName.of('ColorSpace'), cs);
      },
    );
    const { text } = await run(bytes, 'k100');
    expect(text.slice(0, 2)).toEqual(['/CS0 cs', '0 0 0 1 k']);
    expect(text).toContain('/CS0 cs');
    expect(text.filter((t) => t === '/CS0 cs')).toHaveLength(2);
    expect(text).toContain('1 0 0 sc');
  });

  it('リッチブラックの小さな文字は K100 にし、文字の後で元の色に戻す。大きな文字はそのまま', async () => {
    const { text, result } = await run(
      await pdf((c) => `0.5 0.4 0.4 1 k BT /F1 9 Tf 10 10 Td ${c('講')} Tj ET BT /F1 30 Tf 10 100 Td ${c('講')} Tj ET`),
      'k100',
    );
    expect(result.pages[0].richBlackText).toBe(1);
    const tj = text.indexOf('… Tj');
    expect(text.slice(tj - 1, tj + 2)).toEqual(['0 0 0 1 k', '… Tj', '0.5 0.4 0.4 1 k']);
  });
});

describe('CMYK に変換', () => {
  it('文字・線・図形の色を CMYK にする(無彩色は K だけ)', async () => {
    const { text, doc } = await run(await pdf(() => '1 0 0 rg 0.3 g 0 0 0 RG 0.1 0.2 0.3 0.4 k'), 'cmyk');
    const red = rgbToCmyk(1, 0, 0).map((v) => Math.round(v * 100) / 100);
    expect(text).toEqual([`${red.join(' ')} k`, '0 0 0 0.7 k', '0 0 0 1 K', '0.1 0.2 0.3 0.4 k']);
    expect(scanStructure(doc)[0].colorUse.rgb).toBe(0);
  });

  it('RGB の画像を CMYK の画像にする(SMask は残す)。Indexed は色の表だけを変える', async () => {
    let smask: PDFRef | undefined;
    const bytes = await pdf(
      () => 'q 100 0 0 50 10 10 cm /Im1 Do Q q 100 0 0 50 10 100 cm /Im2 Do Q',
      (doc) => {
        const ctx = doc.context;
        smask = ctx.register(ctx.flateStream(new Uint8Array([255, 128]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
        const im1 = ctx.register(ctx.flateStream(new Uint8Array([255, 0, 0, 255, 255, 255]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask }));
        const indexed = ctx.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 1, PDFHexString.of('0000FFFFFFFF')]);
        const im2 = ctx.register(ctx.flateStream(new Uint8Array([0, 1]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, ColorSpace: indexed, BitsPerComponent: 8 }));
        doc.getPage(0).node.setXObject(PDFName.of('Im1'), im1);
        doc.getPage(0).node.setXObject(PDFName.of('Im2'), im2);
      },
    );
    const { doc, result } = await run(bytes, 'cmyk');
    expect(result.pages[0].images).toBe(2);
    const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const im1 = doc.context.lookup(xobjects.get(PDFName.of('Im1'))) as PDFStream;
    expect(im1.dict.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceCMYK');
    expect(im1.dict.get(PDFName.of('SMask'))).toBeDefined();
    const pixels = streamBytes(im1);
    const red = rgbToCmyk(1, 0, 0).map((v) => Math.round(v * 255));
    expect(Array.from(pixels.slice(0, 4))).toEqual(red);
    expect(Array.from(pixels.slice(4, 8))).toEqual([0, 0, 0, 0]);
    const im2 = doc.context.lookup(xobjects.get(PDFName.of('Im2'))) as PDFStream;
    const cs = im2.dict.lookup(PDFName.of('ColorSpace'), PDFArray);
    expect(cs.get(1).toString()).toBe('/DeviceCMYK');
    expect(Array.from(streamBytes(im2))).toEqual([0, 1]);
  });

  it('グラデーションは関数を CMYK の標本にする', async () => {
    const bytes = await pdf(
      () => 'q 0 0 400 300 re W n /Sh1 sh Q',
      (doc) => {
        const ctx = doc.context;
        const sh = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, 400, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } }));
        const shadings = ctx.obj({});
        shadings.set(PDFName.of('Sh1'), sh);
        doc.getPage(0).node.Resources()!.set(PDFName.of('Shading'), shadings);
      },
    );
    const { doc, result } = await run(bytes, 'cmyk');
    expect(result.pages[0].shadings).toBe(1);
    const sh = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Shading'), PDFDict).lookup(PDFName.of('Sh1'), PDFDict);
    expect(sh.get(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceCMYK');
    const fn = loadFunction(doc, sh.get(PDFName.of('Function')))!;
    const red = rgbToCmyk(1, 0, 0);
    fn([0]).forEach((v, k) => expect(v).toBeCloseTo(red[k], 1));
  });

  it('特色は代替の色で CMYK にする。レジストレーション(トンボ用)はそのまま', async () => {
    const bytes = await pdf(
      () => '/Spot cs 0.5 sc /Reg CS 1 SC',
      (doc) => {
        const ctx = doc.context;
        const sep = (name: string) =>
          ctx.obj([PDFName.of('Separation'), PDFName.of(name), PDFName.of('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0.6, 0], N: 1 })]);
        const cs = ctx.obj({});
        cs.set(PDFName.of('Spot'), sep('DIC 156'));
        cs.set(PDFName.of('Reg'), sep('All'));
        doc.getPage(0).node.Resources()!.set(PDFName.of('ColorSpace'), cs);
      },
    );
    const { text } = await run(bytes, 'cmyk');
    // cs の直後の色(濃度 1)も CMYK で指定し、その後の sc を変換する
    expect(text).toEqual(['0 1 0.6 0 k', '0 0.5 0.3 0 k', '/Reg CS', '1 SC']);
  });

  it('透明グループの色空間を CMYK にする', async () => {
    const bytes = await pdf(() => '0 g', (doc) => doc.getPage(0).node.set(PDFName.of('Group'), doc.context.obj({ S: 'Transparency', CS: 'DeviceRGB' })));
    const { doc } = await run(bytes, 'cmyk');
    expect(doc.getPage(0).node.lookup(PDFName.of('Group'), PDFDict).get(PDFName.of('CS'))?.toString()).toBe('/DeviceCMYK');
  });

  it('変換できないもの(JPEG を読む手段がない・インライン画像)は理由を返す', async () => {
    const bytes = await pdf(
      () => 'q 10 0 0 10 0 0 cm /Im1 Do Q q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q',
      (doc) => {
        const ctx = doc.context;
        const jpeg = ctx.register(PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }), new Uint8Array([0xff, 0xd8])));
        doc.getPage(0).node.setXObject(PDFName.of('Im1'), jpeg);
      },
    );
    const { result } = await run(bytes, 'cmyk');
    expect([...result.pages[0].unsupported].sort()).toEqual(['JPEG の画像', 'インライン画像'].sort());
  });
});

describe('白のオーバープリントの解除', () => {
  it('白の間だけオーバープリントを切り、白以外に戻ったら元に戻す。チェックで指摘されなくなる', async () => {
    const bytes = await pdf(() => 'q /OP gs 1 1 1 rg 10 10 50 50 re f 0 0 0 rg 100 10 50 50 re f Q');
    const { text, result, doc } = await run(bytes, 'rgb', true);
    expect(result.pages[0].whiteOverprint).toBe(1);
    const gsOps = text.filter((t) => t.endsWith(' gs'));
    expect(gsOps).toHaveLength(3);
    expect(scanStructure(doc)[0].notes.filter((n) => n.kind === 'white-overprint')).toHaveLength(0);
    const off = doc.getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of(gsOps[1].split(' ')[0].slice(1)), PDFDict);
    expect(off.get(PDFName.of('op'))?.toString()).toBe('false');
  });

  it('解除しない設定なら、内容を変えない', async () => {
    const bytes = await pdf(() => 'q /OP gs 1 1 1 rg 10 10 50 50 re f Q');
    const { result } = await run(bytes, 'rgb', false);
    expect(result.pages[0].whiteOverprint).toBe(0);
  });
});

describe('unfilterPng', () => {
  it('Sub / Up の予測を戻す', () => {
    // 2 × 2 画素、1 成分。1 行目 Sub(1)、2 行目 Up(2)
    const data = new Uint8Array([1, 10, 5, 2, 1, 1]);
    expect(Array.from(unfilterPng(data, 1, 8, 2))).toEqual([10, 15, 11, 16]);
  });
});
