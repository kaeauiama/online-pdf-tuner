import { describe, expect, it } from 'vitest';
import { mmToPt, ptToMm, rect, rectHeight, rectWidth } from '../../src/print/geometry.ts';
import { resolveLayout } from '../../src/print/layout.ts';
import { findPaperSize } from '../../src/print/paperSizes.ts';
import { findProfile } from '../../src/print/profiles.ts';
import type { PageStructure } from '../../src/print/structure.ts';

function page(wMm: number, hMm: number, extra: Partial<PageStructure> = {}): PageStructure {
  const box = rect(0, 0, mmToPt(wMm), mmToPt(hMm));
  return {
    index: 0,
    mediaBox: box,
    cropBox: box,
    rotation: 0,
    fonts: [],
    annotations: { links: 0, widgets: 0, others: 0 },
    images: [],
    colorUse: { rgb: 0, cmyk: 0, gray: 0, spot: 0, other: 0 },
    transparency: false,
    fullyTransparent: false,
    notes: [],
    spotColors: [],
    rgbAreas: [],
    ...extra,
  };
}

const generic = findProfile('generic');
const tcpc = findProfile('tcpc');
const mm = (v: number) => Math.round(ptToMm(v) * 10) / 10;

describe('resolveLayout', () => {
  it('A5 ちょうどなら「仕上がりサイズ(塗り足しなし)」', () => {
    const l = resolveLayout(page(148, 210), generic, 'auto');
    expect(l.kind).toBe('trim');
    expect(l.paper?.id).toBe('A5');
    expect(l.bleedMm).toBe(0);
  });

  it('154×216mm は「A5 + 塗り足し 3mm」と判定し、仕上がり位置を内側 3mm にとる', () => {
    const l = resolveLayout(page(154, 216), tcpc, 'auto');
    expect(l.kind).toBe('trim+bleed');
    expect(l.paper?.id).toBe('A5');
    expect(l.bleedMm).toBeCloseTo(3, 1);
    expect(mm(l.trim.x0)).toBe(3);
    expect(mm(rectWidth(l.trim))).toBe(148);
    // 安全領域は印刷所ごと(東京カラー印刷は 3mm)
    expect(mm(l.safe.x0)).toBe(6);
  });

  it('横向き(A4 横 + 塗り足し)も判定する', () => {
    const l = resolveLayout(page(303, 216), generic, 'auto');
    expect(l.kind).toBe('trim+bleed');
    expect(l.paper?.id).toBe('A4');
    expect(l.landscape).toBe(true);
  });

  it('PowerPoint の丸め程度の誤差(±1mm)は許容する', () => {
    expect(resolveLayout(page(148.4, 209.6), generic, 'auto').paper?.id).toBe('A5');
  });

  it('どのサイズにも合わなければ unknown(ページ全体を仕上がりとみなす)', () => {
    const l = resolveLayout(page(160, 230), generic, 'auto');
    expect(l.kind).toBe('unknown');
    expect(mm(rectHeight(l.trim))).toBe(230);
  });

  it('サイズを指定した場合は、そのサイズとだけ照合する', () => {
    const a5 = findPaperSize('A5')!;
    expect(resolveLayout(page(154, 216), generic, a5).kind).toBe('trim+bleed');
    expect(resolveLayout(page(210, 297), generic, a5).kind).toBe('unknown');
  });

  it('TrimBox があればそれを仕上がり位置として使う', () => {
    const media = rect(0, 0, mmToPt(170), mmToPt(232));
    const trim = rect(mmToPt(11), mmToPt(11), mmToPt(159), mmToPt(221));
    const bleed = rect(mmToPt(8), mmToPt(8), mmToPt(162), mmToPt(224));
    const l = resolveLayout(page(170, 232, { mediaBox: media, cropBox: media, trimBox: trim, bleedBox: bleed }), generic, 'auto');
    expect(l.kind).toBe('trimbox');
    expect(l.paper?.id).toBe('A5');
    expect(l.bleedMm).toBeCloseTo(3, 1);
  });
});
