// D-027: 埋め込みのフォントにない字を、PC にある同じフォントから補う
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@cantoo/fontkit';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { lexContent } from '../../src/pdf/lexer.ts';
import { pageContentBytes } from '../../src/print/structure.ts';
import { createLocalFont, normalizeFontName, type LocalFont } from '../../src/typo/localFonts.ts';
import { applyTypos, findTypos, textRuns, type LocalFontLookup } from '../../src/typo/typo.ts';

const FONT = new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'fonts', 'BIZUDPGothic-Regular.subset.ttf')));

/** 「講習回」だけを書いた PDF(埋め込みのサブセットには、この 3 字しか入らない) */
async function sourcePdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  doc.addPage([300, 200]).drawText('講習回', { x: 20, y: 100, size: 24, font });
  return PDFDocument.load(await doc.save());
}

const text = (doc: PDFDocument) =>
  textRuns(doc, doc.getPage(0))
    .runs.flatMap((r) => r.glyphs.map((g) => g.text))
    .join('');

async function pcFont(): Promise<LocalFont> {
  const f = await createLocalFont(FONT, 'BIZUDPGothic-Regular');
  if (!f) throw new Error('font');
  return f;
}

describe('normalizeFontName', () => {
  it('サブセット接頭辞・装飾・記号を除いて比べる', () => {
    expect(normalizeFontName('ABCDEF+BIZUDPGothic-Regular')).toBe('bizudpgothicregular');
    expect(normalizeFontName('Meiryo UI,Bold')).toBe('meiryoui');
    expect(normalizeFontName('MS-Mincho')).toBe(normalizeFontName('MS Mincho'));
    expect(normalizeFontName('BIZUDPGothic-Regular-9742')).toBe('bizudpgothicregular');
  });
});

describe('createLocalFont', () => {
  it('字の有無・字幅・埋め込みの許諾を読む', async () => {
    const f = await pcFont();
    expect(f.hasChar('会')).toBe(true);
    expect(f.hasChar('𠮷')).toBe(false);
    expect(f.widthOf('会')).toBeCloseTo(1000, 0);
    expect(f.permission).toBe('editable');
  });
});

describe('PC のフォントで補う', () => {
  it('補わなければ直さない。補えば置き換えられ、文字として読み出せる', async () => {
    const doc = await sourcePdf();
    expect(text(doc)).toBe('講習回');
    // pdf-lib で埋め込んだサブセットには許諾(OS/2)が残らないため、PC のフォントなしでは許諾が分からない
    expect(findTypos(doc, [0], '回', '会')[0]).toMatchObject({ fixable: false, reason: 'TYPO_FONT_LICENSE_UNKNOWN' });

    const local = await pcFont();
    const lookup: LocalFontLookup = (name) => (normalizeFontName(name) === normalizeFontName(local.postscriptName) ? local : undefined);
    const matches = findTypos(doc, [0], '回', '会', lookup);
    expect(matches[0]).toMatchObject({ fixable: true, replacements: [{ local: '会' }] });
    expect(matches[0].localKey).toBeDefined();

    expect(await applyTypos(doc, matches, lookup)).toBe(1);
    const saved = await PDFDocument.load(await doc.save());
    expect(text(saved)).toBe('講習会');
    // 補った字の部分だけフォントを切り替え、最後に元のフォントに戻す
    const tfs = lexContent(pageContentBytes(saved, saved.getPage(0))).filter((o) => o.op === 'Tf');
    expect(tfs.length).toBeGreaterThanOrEqual(3);
  });

  it('許諾が読める埋め込みのフォントで、PC にフォントがなければ TYPO_LOCAL_FONT_NOT_FOUND', async () => {
    const doc = await sourcePdf();
    const local = await pcFont();
    // 許諾は PC のフォントで確認できたが、字を補うフォントはない(別名で登録されている場合など)
    let calls = 0;
    const lookup: LocalFontLookup = () => (calls++ === 0 ? local : undefined);
    expect(findTypos(doc, [0], '回', '会', lookup)[0]).toMatchObject({ reason: 'TYPO_LOCAL_FONT_NOT_FOUND', detail: '会' });
  });

  it('PC のフォントが編集を許可していなければ、同じフォントとして直さない(TYPO_FONT_LICENSE)', async () => {
    const doc = await sourcePdf();
    const local = { ...(await pcFont()), permission: 'preview-print' as const };
    expect(findTypos(doc, [0], '回', '会', () => local)[0]).toMatchObject({ reason: 'TYPO_FONT_LICENSE' });
  });

  it('PC のフォントにも字がなければ TYPO_GLYPH_MISSING', async () => {
    const doc = await sourcePdf();
    const local = await pcFont();
    expect(findTypos(doc, [0], '回', '𠮷', () => local)[0]).toMatchObject({ reason: 'TYPO_GLYPH_MISSING', detail: '𠮷' });
  });

  it('字幅が違えば TYPO_WIDTH_MISMATCH', async () => {
    const doc = await sourcePdf();
    const base = await pcFont();
    const local: LocalFont = { ...base, widthOf: () => 500 };
    expect(findTypos(doc, [0], '回', '会', () => local)[0]).toMatchObject({ reason: 'TYPO_WIDTH_MISMATCH' });
  });
});
