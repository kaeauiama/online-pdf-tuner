import { degrees, PDFDocument, PDFName, rgb } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { lexContent } from '../../src/pdf/lexer.ts';
import { blankPagesForSaddle, buildPrintReady, type FixOptions } from '../../src/print/fix.ts';
import { mmToPt, ptToMm, rect, rectHeight, rectWidth, type Rect } from '../../src/print/geometry.ts';
import { resolveLayout } from '../../src/print/layout.ts';
import { MARK_MARGIN_MM, trimMarkSegments } from '../../src/print/marks.ts';
import { findProfile } from '../../src/print/profiles.ts';
import { pageContentBytes, scanStructure } from '../../src/print/structure.ts';

const profile = findProfile('tcpc');
const mm = (pt: number) => Math.round(ptToMm(pt) * 10) / 10;

async function source(wMm: number, hMm: number, pages = 1, rotation = 0): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([mmToPt(wMm), mmToPt(hMm)]);
    p.drawRectangle({ x: 0, y: 0, width: mmToPt(wMm), height: mmToPt(hMm), color: rgb(0.2, 0.4, 0.8) });
    if (rotation) p.setRotation(degrees(rotation));
  }
  return PDFDocument.load(await doc.save());
}

async function fix(doc: PDFDocument, over: Partial<FixOptions> = {}) {
  const layouts = scanStructure(doc).map((s) => resolveLayout(s, profile, 'auto'));
  const options: FixOptions = { bleedMm: 3, marks: false, method: 'mirror', targetPages: 'all', regionFit: 'cover', ...over };
  const result = await buildPrintReady(doc, layouts, options);
  const out = await PDFDocument.load(result.bytes);
  return { result, out, structures: scanStructure(out) };
}

const sizeMm = (r: Rect) => [mm(rectWidth(r)), mm(rectHeight(r))];

describe('buildPrintReady: ページの大きさとボックス', () => {
  it('塗り足しなしの A5 → 塗り足し込み(154×216mm)。TrimBox と BleedBox を設定する', async () => {
    const { structures } = await fix(await source(148, 210));
    const s = structures[0];
    expect(sizeMm(s.mediaBox)).toEqual([154, 216]);
    expect(sizeMm(s.trimBox!)).toEqual([148, 210]);
    expect(mm(s.trimBox!.x0)).toBe(3);
    expect(sizeMm(s.bleedBox!)).toEqual([154, 216]);
  });

  it('トンボ付き: 塗り足しの外側に余白を取り、ページを大きくする', async () => {
    const { structures } = await fix(await source(148, 210), { marks: true });
    const s = structures[0];
    const margin = 3 + MARK_MARGIN_MM;
    expect(sizeMm(s.mediaBox)).toEqual([148 + 2 * margin, 210 + 2 * margin]);
    expect(mm(s.trimBox!.x0)).toBe(margin);
    expect(mm(s.bleedBox!.x0)).toBe(MARK_MARGIN_MM);
  });

  it('トンボはレジストレーション色(Separation /All)で描く', async () => {
    const { out } = await fix(await source(148, 210), { marks: true });
    const page = out.getPage(0);
    const ops = lexContent(pageContentBytes(out, page));
    const cs = ops.find((o) => o.op === 'CS');
    expect(cs?.operands[0]).toEqual({ type: 'name', value: 'CSRegistration' });
    const spaces = page.node.Resources()!.lookup(PDFName.of('ColorSpace'));
    expect(String(spaces)).toContain('/Separation /All /DeviceCMYK');
  });

  it('元から塗り足しがあるページは、そのまま置いてボックスだけ設定する', async () => {
    const { structures, result } = await fix(await source(154, 216));
    expect(result.pages[0].method).toBe('existing');
    expect(sizeMm(structures[0].mediaBox)).toEqual([154, 216]);
    expect(sizeMm(structures[0].trimBox!)).toEqual([148, 210]);
  });

  it('ページの回転を引き継ぐ', async () => {
    const { structures } = await fix(await source(148, 210, 1, 90));
    expect(structures[0].rotation).toBe(90);
  });

  it('仕上がりサイズが分からないページがあれば PRINT_FIX_SIZE_UNKNOWN', async () => {
    await expect(fix(await source(160, 230))).rejects.toMatchObject({ code: 'PRINT_FIX_SIZE_UNKNOWN' });
  });
});

describe('buildPrintReady: 塗り足しの作り方', () => {
  const drawCount = async (over: Partial<FixOptions>) => {
    const { out } = await fix(await source(148, 210), over);
    return lexContent(pageContentBytes(out, out.getPage(0))).filter((o) => o.op === 'Do').length;
  };

  it('鏡写し: 中央 1 + 辺 4 + 角 4 = 9 回描く', async () => {
    expect(await drawCount({ method: 'mirror' })).toBe(9);
  });

  it('塗り足しなし・拡大: 1 回だけ描く', async () => {
    expect(await drawCount({ method: 'none' })).toBe(1);
    expect(await drawCount({ method: 'scale' })).toBe(1);
  });

  it('拡大: 切れる量を知らせる(A5 なら約 4.3mm)', async () => {
    const { result } = await fix(await source(148, 210), { method: 'scale' });
    expect(result.pages[0].notes.join()).toContain('約 4.3mm');
  });

  it('対象外のページには塗り足しを付けない', async () => {
    const { result } = await fix(await source(148, 210, 2), { method: 'mirror', targetPages: new Set([0]) });
    expect(result.pages.map((p) => p.method)).toEqual(['mirror', 'none']);
  });

  it('白いフチを取り除く(縦横比を保つ): はみ出して切れる量を知らせる', async () => {
    // 余白 20mm の内側(108×170mm)を、154×216mm に合わせる
    const bounds = rect(mmToPt(20), mmToPt(20), mmToPt(128), mmToPt(190));
    const { result } = await fix(await source(148, 210), { method: 'region', contentBounds: new Map([[0, bounds]]) });
    const notes = result.pages[0].notes.join();
    expect(result.pages[0].method).toBe('region');
    expect(notes).toContain('上下');
    expect(notes).toContain('拡大');
  });

  it('白いフチを取り除く(縦横比を変える): 変形の大きさを知らせる', async () => {
    const bounds = rect(mmToPt(20), mmToPt(20), mmToPt(128), mmToPt(190));
    const { result } = await fix(await source(148, 210), {
      method: 'region',
      regionFit: 'stretch',
      contentBounds: new Map([[0, bounds]]),
    });
    expect(result.pages[0].notes.join()).toMatch(/約 [\d.]+% 横に伸びています/);
  });

  it('中身の範囲が分からないページは、白いフチの処理をせず塗り足しなしにする', async () => {
    const { result } = await fix(await source(148, 210), { method: 'region', contentBounds: new Map() });
    expect(result.pages[0].method).toBe('none');
  });
});

describe('trimMarkSegments', () => {
  const trim = rect(mmToPt(16), mmToPt(16), mmToPt(164), mmToPt(226));
  const bleed = rect(mmToPt(13), mmToPt(13), mmToPt(167), mmToPt(229));

  it('角トンボ 4 × 4 本 + センタートンボ 4 × 2 本', () => {
    expect(trimMarkSegments(trim, bleed)).toHaveLength(24);
  });

  it('トンボは塗り足しの内側に入らない', () => {
    const inside = (x: number, y: number) => x > bleed.x0 + 0.01 && x < bleed.x1 - 0.01 && y > bleed.y0 + 0.01 && y < bleed.y1 - 0.01;
    for (const [x0, y0, x1, y1] of trimMarkSegments(trim, bleed)) {
      expect(inside(x0, y0) || inside(x1, y1)).toBe(false);
      expect(inside((x0 + x1) / 2, (y0 + y1) / 2)).toBe(false);
    }
  });

  it('仕上がり線と塗り足し線の位置に線がある', () => {
    const segs = trimMarkSegments(trim, bleed);
    const verticalXs = new Set(segs.filter(([x0, , x1]) => x0 === x1).map(([x]) => Math.round(ptToMm(x) * 10) / 10));
    for (const x of [13, 16, 164, 167, 90]) expect(verticalXs.has(x)).toBe(true);
  });
});

describe('blankPagesForSaddle', () => {
  it.each([
    [4, 0],
    [5, 3],
    [6, 2],
    [7, 1],
    [8, 0],
  ])('%i ページ → %i 枚', (pages, blanks) => {
    expect(blankPagesForSaddle(pages)).toBe(blanks);
  });
});
