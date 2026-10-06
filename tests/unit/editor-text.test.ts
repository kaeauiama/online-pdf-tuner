// ページ内の編集: 文字表示の命令 1 つ分の書き換え(textEdit.ts)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyElementEdits } from '../../src/editor/edit.ts';
import { extractElements } from '../../src/editor/elements.ts';
import { planTextEdit, textEditSplices, textLines, textPlanWarnings, type TextPlan } from '../../src/editor/textEdit.ts';
import { pageContentBytes } from '../../src/print/structure.ts';
import { spliceAll } from '../../src/pdf/serialize.ts';
import { createLocalFont, normalizeFontName } from '../../src/typo/localFonts.ts';
import { typoPdf } from './typoFixture.ts';

// typoPdf のコード: 1 講 / 2 習 / 3 会 / 4 回 / 5 案(案だけ字幅 500)
const EDITABLE = 0;

async function load(fsType: number | undefined, content?: string) {
  const doc = await PDFDocument.load(await typoPdf(fsType, content));
  return { doc, page: doc.getPage(0), opIndex: [...textLines(doc, doc.getPage(0)).keys()][0] };
}

async function applied(doc: PDFDocument, changes: Map<number, string>, localFonts?: Parameters<typeof textEditSplices>[3]) {
  const page = doc.getPage(0);
  const content = pageContentBytes(doc, page);
  const splices = await textEditSplices(doc, page, changes, localFonts);
  const next = spliceAll(content, splices);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  const out = await PDFDocument.load(await doc.save());
  return { doc: out, lines: [...textLines(out, out.getPage(0)).values()].map((l) => l.text), content: new TextDecoder().decode(pageContentBytes(out, out.getPage(0))) };
}

const ok = (p: TextPlan) => {
  if (!p.ok) throw new Error(`not ok: ${p.code}`);
  return p;
};

describe('planTextEdit', () => {
  it('同じ幅の字への置き換えは、注意なしで書き換えられる', async () => {
    const { doc, page, opIndex } = await load(EDITABLE);
    expect(textLines(doc, page).get(opIndex)?.text).toBe('講習回');
    const plan = ok(planTextEdit(doc, page, opIndex, '講習会'));
    expect(plan.widthRatio).toBeCloseTo(1);
    expect(textPlanWarnings(plan)).toEqual([]);
  });

  it('字数や字幅が変わってもよい。幅の変化を注意として示す', async () => {
    const { doc, page, opIndex } = await load(EDITABLE);
    const narrower = ok(planTextEdit(doc, page, opIndex, '講習案'));
    expect(narrower.widthRatio).toBeCloseTo(2500 / 3000);
    expect(textPlanWarnings(narrower)[0]).toContain('狭く');
    const longer = ok(planTextEdit(doc, page, opIndex, '講習会回'));
    expect(longer.widthRatio).toBeCloseTo(4 / 3);
    expect(textPlanWarnings(longer)[0]).toContain('広く');
    expect(ok(planTextEdit(doc, page, opIndex, '')).widthRatio).toBe(0);
  });

  it('埋め込みのフォントにない字・編集を許可していないフォント・許諾が読めないフォントは、理由を示して書き換えない', async () => {
    const { doc, page, opIndex } = await load(EDITABLE);
    expect(planTextEdit(doc, page, opIndex, '講習X')).toMatchObject({ ok: false, code: 'TEXT_GLYPH_MISSING', detail: 'X' });
    const pp = await load(0x0004);
    expect(planTextEdit(pp.doc, pp.page, pp.opIndex, '講習会')).toMatchObject({ ok: false, code: 'TEXT_FONT_LICENSE' });
    const unknown = await load(undefined);
    expect(planTextEdit(unknown.doc, unknown.page, unknown.opIndex, '講習会')).toMatchObject({ ok: false, code: 'TEXT_FONT_LICENSE_UNKNOWN' });
  });

  it('変えていない字の字間の調整は残し、変えた部分の調整だけを外す', async () => {
    const { doc, page, opIndex } = await load(EDITABLE, '<0001> -200 <0002> 100 <0004>');
    expect(ok(planTextEdit(doc, page, opIndex, '講習回')).kerningDropped).toBe(false);
    const plan = ok(planTextEdit(doc, page, opIndex, '講習会'));
    expect(plan.kerningDropped).toBe(true);
    const after = await applied(doc, new Map([[opIndex, '講習会']]));
    expect(after.lines).toEqual(['講習会']);
    expect(after.content).toContain('[<0001> -200 <00020003>] TJ');
  });
});

describe('textEditSplices', () => {
  it('書き換えた文字は、文字として読み出せる(字数が変わる場合も)', async () => {
    for (const next of ['講習会', '講習', '会講習回案', '']) {
      const { doc, opIndex } = await load(EDITABLE);
      expect((await applied(doc, new Map([[opIndex, next]]))).lines).toEqual(next ? [next] : []);
    }
  });

  it("' の命令は、行の移動を残して書き換える", async () => {
    const doc = await PDFDocument.load(await typoPdf(EDITABLE));
    const page = doc.getPage(0);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode('BT /F1 24 Tf 30 TL 20 100 Td <00010002> \' ET'))));
    const opIndex = [...textLines(doc, page).keys()][0];
    const after = await applied(doc, new Map([[opIndex, '会習']]));
    expect(after.content).toContain("T* [<00030002>] TJ");
    expect(after.lines).toEqual(['会習']);
  });

  it('要素の移動と一緒に書き込める(同じ位置基準)', async () => {
    const doc = await PDFDocument.load(await typoPdf(EDITABLE, '<000100020004>'));
    const page = doc.getPage(0);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode('q BT /F1 24 Tf 20 100 Td [<000100020004>] TJ ET Q'))));
    const elements = extractElements(doc, page);
    const opIndex = [...textLines(doc, page).keys()][0];
    const splices = await textEditSplices(doc, page, new Map([[opIndex, '講習会']]));
    const next = applyElementEdits(pageContentBytes(doc, page), elements, new Map([[0, { kind: 'transform', dx: 10, dy: 0, scale: 1, anchor: [0, 0] }]]), undefined, splices);
    expect(new TextDecoder().decode(next).trim()).toBe('q 1 0 0 1 10 0 cm BT /F1 24 Tf 20 100 Td [<000100020003>] TJ ET Q');
  });
});

describe('PC のフォントで補う', () => {
  const FONT = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf')));

  it('埋め込みにない字を PC のフォントで描き、その後は元のフォントに戻す', async () => {
    const src = await PDFDocument.create();
    src.registerFontkit(fontkit);
    const font = await src.embedFont(FONT, { subset: true });
    src.addPage([300, 200]).drawText('講習回', { x: 20, y: 100, size: 24, font });
    const doc = await PDFDocument.load(await src.save());
    const page = doc.getPage(0);
    const opIndex = [...textLines(doc, page).keys()][0];
    // pdf-lib のサブセットには許諾が残らないので、PC のフォントなしでは書き換えない
    expect(planTextEdit(doc, page, opIndex, '講習会')).toMatchObject({ ok: false, code: 'TEXT_FONT_LICENSE_UNKNOWN' });
    const local = (await createLocalFont(FONT, 'BIZUDPGothic-Regular'))!;
    const lookup = (name: string) => (normalizeFontName(name) === normalizeFontName(local.postscriptName) ? local : undefined);
    const plan = ok(planTextEdit(doc, page, opIndex, '新しい講習会', lookup));
    expect(plan.usesLocal).toBe(true);
    const after = await applied(doc, new Map([[opIndex, '新しい講習会']]), lookup);
    expect(after.lines.join('')).toBe('新しい講習会');
    expect(after.content).toMatch(/\/FEditLocal\S* 24 Tf .* TJ \/F\S+ 24 Tf/);
  });
});
