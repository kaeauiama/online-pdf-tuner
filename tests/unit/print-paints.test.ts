// 入稿チェック(D-033): 細い線・塗りだけの線・白のオーバープリント・小さな文字・リッチブラック・総インキ量・
// 特色・レジストレーション・非表示のレイヤー。合成 PDF のコンテンツを直接書いて確かめる。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFName, PDFRef } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { runChecks, type PrintCode } from '../../src/print/checks.ts';
import { findProfile } from '../../src/print/profiles.ts';
import { scanStructure, type PaintNoteKind } from '../../src/print/structure.ts';

const FONT = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf'));
// A5(148×210mm)の大きさのページ
const W = 419.53;
const H = 595.28;

async function pageWith(content: (code: (t: string) => string) => string, setup?: (doc: PDFDocument) => void): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(FONT, { subset: true });
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  const ctx = doc.context;
  page.node.setExtGState(PDFName.of('OP'), ctx.register(ctx.obj({ Type: 'ExtGState', OP: true, op: true })));
  const tint = (name: string) =>
    ctx.obj([
      PDFName.of('Separation'),
      PDFName.of(name),
      PDFName.of('DeviceCMYK'),
      ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }),
    ]);
  const cs = ctx.obj({});
  cs.set(PDFName.of('Reg'), tint('All'));
  cs.set(PDFName.of('Spot'), tint('PANTONE 123 C'));
  page.node.Resources()!.set(PDFName.of('ColorSpace'), cs);
  setup?.(doc);
  const text = content((t) => font.encodeText(t).toString());
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(new TextEncoder().encode(text))));
  return PDFDocument.load(await doc.save());
}

const notesOf = (doc: PDFDocument): PaintNoteKind[] => scanStructure(doc)[0].notes.map((n) => n.kind);

function codesOf(doc: PDFDocument): PrintCode[] {
  const facts = scanStructure(doc).map((structure) => ({ structure }));
  return runChecks(facts, { profile: findProfile('generic'), paper: 'auto', binding: 'none' }).findings.map((f) => f.code);
}

describe('線', () => {
  it('線幅 0 の線と、0.1mm 未満の細い線を見つける。普通の線は対象外', async () => {
    const doc = await pageWith(
      () => `q 0 w 0 G 50 100 m 300 100 l S Q
q 0.1 w 0 G 50 200 m 300 200 l S Q
q 1 w 0 G 50 300 m 300 300 l S Q`,
    );
    const notes = scanStructure(doc)[0].notes;
    expect(notes.filter((n) => n.kind === 'zero-width-line')).toHaveLength(1);
    const thin = notes.filter((n) => n.kind === 'thin-line');
    expect(thin).toHaveLength(1);
    expect(thin[0].value).toBeCloseTo(0.035, 2);
    expect(codesOf(doc)).toEqual(expect.arrayContaining(['PRINT_LINE_ZERO_WIDTH', 'PRINT_LINE_TOO_THIN']));
  });

  it('CTM で縮小された線は、縮小後の太さで判定する', async () => {
    const doc = await pageWith(() => `q 0.1 0 0 0.1 0 0 cm 2 w 0 G 500 1000 m 3000 1000 l S Q`);
    expect(notesOf(doc)).toEqual(['thin-line']);
  });

  it('塗りの細い長方形(表の罫線など)も、細すぎれば細い線として扱う', async () => {
    const doc = await pageWith(() => `q 0 g 50 100 250 0.15 re f Q
q 0 g 50 200 250 2 re f Q`);
    expect(notesOf(doc)).toEqual(['thin-line']);
  });

  it('面積のない形を塗りだけで描いたもの(印刷されない線)を見つける', async () => {
    const doc = await pageWith(() => `q 0 g 50 100 m 300 300 l f Q
q 0 g 50 400 m 300 400 l 300 450 l f Q`);
    expect(notesOf(doc)).toEqual(['fill-only-line']);
    expect(codesOf(doc)).toContain('PRINT_FILL_ONLY_LINE');
  });

  it('白い線や塗りは、細くても指摘しない(見えないので問題にならない)', async () => {
    const doc = await pageWith(() => `q 0.1 w 1 G 50 100 m 300 100 l S Q`);
    expect(notesOf(doc)).toEqual([]);
  });
});

describe('色', () => {
  it('白のオーバープリントを見つける(RGB・CMYK・グレー)。白でなければ対象外', async () => {
    const doc = await pageWith(() => `q /OP gs 1 1 1 rg 50 50 50 50 re f Q
q /OP gs 0 0 0 0 k 150 50 50 50 re f Q
q /OP gs 1 g 250 50 50 50 re f Q
q /OP gs 0 0 0 1 k 50 150 50 50 re f Q
q 1 1 1 rg 150 150 50 50 re f Q`);
    expect(notesOf(doc)).toEqual(['white-overprint', 'white-overprint', 'white-overprint']);
    expect(codesOf(doc)).toContain('PRINT_WHITE_OVERPRINT');
  });

  it('総インキ量が 350% を超える CMYK の色を見つける', async () => {
    const doc = await pageWith(() => `q 1 1 1 1 k 50 50 50 50 re f Q
q 0.4 0.4 0.4 1 k 150 50 50 50 re f Q`);
    const notes = scanStructure(doc)[0].notes.filter((n) => n.kind === 'ink-over');
    expect(notes.map((n) => n.value)).toEqual([400]);
    expect(codesOf(doc)).toContain('PRINT_INK_OVER_LIMIT');
  });

  it('レジストレーションは仕上がりの内側だけ指摘し、特色の名前を集める', async () => {
    const doc = await pageWith(() => `q /Reg cs 1 sc 50 50 50 50 re f Q
q /Reg CS 1 SC 0.3 w -20 -20 m -5 -5 l S Q
q /Spot cs 0.5 sc 150 50 50 50 re f Q`);
    const structure = scanStructure(doc)[0];
    expect(structure.spotColors).toEqual(['PANTONE 123 C']);
    const facts = [{ structure }];
    const report = runChecks(facts, { profile: findProfile('generic'), paper: 'auto', binding: 'none' });
    const reg = report.findings.find((f) => f.code === 'PRINT_REGISTRATION_COLOR')!;
    expect(reg.marks).toHaveLength(1);
    expect(report.findings.map((f) => f.code)).toContain('PRINT_SPOT_COLOR');
  });
});

describe('文字', () => {
  it('5pt 未満の文字と、12pt 未満のリッチブラックの文字を見つける', async () => {
    const doc = await pageWith(
      (code) => `BT /F1 4 Tf 50 500 Td ${code('講習会')} Tj ET
BT /F1 10 Tf 0.4 0.4 0.4 1 k 50 400 Td ${code('講習会')} Tj ET
BT /F1 10 Tf 0 0 0 1 k 50 300 Td ${code('講習会')} Tj ET
BT /F1 20 Tf 0.4 0.4 0.4 1 k 50 200 Td ${code('講習会')} Tj ET`,
    );
    const notes = scanStructure(doc)[0].notes;
    const small = notes.filter((n) => n.kind === 'small-text');
    expect(small).toHaveLength(1);
    expect(small[0]).toMatchObject({ label: '講習会' });
    expect(small[0].value).toBeCloseTo(4);
    expect(notes.filter((n) => n.kind === 'rich-black-text')).toHaveLength(1);
    expect(codesOf(doc)).toEqual(expect.arrayContaining(['PRINT_SMALL_TEXT', 'PRINT_RICH_BLACK_TEXT']));
  });

  it('縮小した CTM の中の文字は、実際に描かれる大きさで判定する', async () => {
    const doc = await pageWith((code) => `q 0.25 0 0 0.25 0 0 cm BT /F1 12 Tf 200 2000 Td ${code('講')} Tj ET Q`);
    expect(scanStructure(doc)[0].notes.find((n) => n.kind === 'small-text')?.value).toBeCloseTo(3);
  });

  it('見えない文字(描画モード 3)は対象外', async () => {
    const doc = await pageWith((code) => `BT 3 Tr /F1 3 Tf 50 500 Td ${code('講')} Tj ET`);
    expect(notesOf(doc)).toEqual([]);
  });
});

describe('非表示のレイヤー', () => {
  it('既定で非表示のレイヤー(OCG)の中の描画を見つける', async () => {
    let ocg: PDFRef | undefined;
    const doc = await pageWith(
      () => `/OC /L1 BDC q 0 g 50 50 50 50 re f Q EMC
q 0 g 150 50 50 50 re f Q`,
      (d) => {
        const ctx = d.context;
        ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: ctx.obj('(下書き)' as never) }));
        d.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
        const props = ctx.obj({});
        props.set(PDFName.of('L1'), ocg);
        d.getPage(0).node.Resources()!.set(PDFName.of('Properties'), props);
      },
    );
    expect(notesOf(doc)).toEqual(['hidden-layer']);
    expect(codesOf(doc)).toContain('PRINT_HIDDEN_LAYER');
  });
});

describe('RGB で描いた範囲(くすみ警告の対象)', () => {
  it('RGB の塗りだけを記録し、CMYK・グレーは記録しない。RGB のグラデーションがあればページ全体', async () => {
    const cmykOnly = await pageWith(() => 'q 1 0 0 0 k 10 10 50 50 re f Q q 0.5 g 100 10 50 50 re f Q');
    expect(scanStructure(cmykOnly)[0].rgbAreas).toEqual([]);
    const mixed = await pageWith(() => 'q 0 0 1 rg 10 10 50 50 re f Q q 0 1 0 0 k 100 10 50 50 re f Q');
    const areas = scanStructure(mixed)[0].rgbAreas;
    expect(areas).toHaveLength(1);
    expect(areas !== 'all' && areas[0]).toMatchObject({ x0: 10, y0: 10, x1: 60, y1: 60 });
    const shading = await pageWith(
      () => '/Sh1 sh',
      (d) => {
        const sh = d.context.obj({});
        sh.set(PDFName.of('Sh1'), d.context.register(d.context.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, 100, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } })));
        d.getPage(0).node.Resources()!.set(PDFName.of('Shading'), sh);
      },
    );
    expect(scanStructure(shading)[0].rgbAreas).toBe('all');
  });
});
