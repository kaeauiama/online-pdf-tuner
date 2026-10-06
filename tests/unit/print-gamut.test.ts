import { describe, expect, it } from 'vitest';
import { chromaExcess, highlightOutOfGamut, labToSrgb, measureGamut, simulatePrint, srgbToLab } from '../../src/print/gamut.ts';
import { GAMUT_MAX_CHROMA } from '../../src/print/gamutTable.ts';
import { rect } from '../../src/print/geometry.ts';

describe('srgbToLab / labToSrgb', () => {
  it('白・黒・灰色', () => {
    expect(srgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 1);
    expect(srgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 1);
    const [, a, b] = srgbToLab(128, 128, 128);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });

  it('既知の値(sRGB の青 → Lab D50 ≒ 29.6, 68.3, -112)', () => {
    const [L, a, b] = srgbToLab(0, 0, 255);
    expect(L).toBeCloseTo(29.6, 0);
    expect(a).toBeCloseTo(68.3, 0);
    expect(b).toBeCloseTo(-112.0, 0);
  });

  it('往復で元の色に戻る', () => {
    for (const c of [[255, 0, 0], [12, 200, 90], [240, 230, 140], [30, 30, 80]] as const) {
      const back = labToSrgb(...srgbToLab(c[0], c[1], c[2]));
      back.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(1));
    }
  });
});

describe('chromaExcess(印刷で出せる彩度を超える量)', () => {
  it('表は空でない', () => {
    expect(Math.max(...GAMUT_MAX_CHROMA)).toBeGreaterThan(60);
  });

  it('鮮やかな青・緑は大きく超える(印刷でくすむ代表例)', () => {
    expect(chromaExcess(0, 0, 255)).toBeGreaterThan(20);
    expect(chromaExcess(0, 255, 0)).toBeGreaterThan(20);
  });

  it('灰色・肌色・落ち着いた色は範囲内', () => {
    expect(chromaExcess(128, 128, 128)).toBe(0);
    expect(chromaExcess(230, 190, 160)).toBe(0);
    expect(chromaExcess(120, 90, 60)).toBe(0);
  });
});

function pixels(colors: [number, number, number][], alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((c, i) => data.set([...c, alpha], i * 4));
  return data;
}

describe('measureGamut', () => {
  it('くすみやすい画素を数え、透明な画素と範囲外は数えない', () => {
    const data = pixels([
      [0, 0, 255],
      [128, 128, 128],
      [0, 255, 0],
      [230, 190, 160],
    ]);
    expect(measureGamut(data, 4, 1)).toEqual({ pixels: 4, moderate: 2, strong: 2 });
    expect(measureGamut(data, 4, 1, rect(1, 0, 2, 1))).toEqual({ pixels: 1, moderate: 0, strong: 0 });
    expect(measureGamut(pixels([[0, 0, 255]], 0), 1, 1).pixels).toBe(0);
  });
});

describe('simulatePrint / highlightOutOfGamut', () => {
  it('範囲外の色は彩度が下がり、範囲内の色は変わらない', () => {
    const out = simulatePrint(pixels([[0, 0, 255], [128, 128, 128]]));
    const [L0, a0, b0] = srgbToLab(0, 0, 255);
    const [L1, a1, b1] = srgbToLab(out[0], out[1], out[2]);
    expect(Math.hypot(a1, b1)).toBeLessThan(Math.hypot(a0, b0) - 20);
    expect(Math.abs(L1 - L0)).toBeLessThan(8);
    expect(Math.atan2(b1, a1)).toBeCloseTo(Math.atan2(b0, a0), 0);
    expect([...out.slice(4, 8)]).toEqual([128, 128, 128, 255]);
  });

  it('くすみやすい色だけを元の色で残し、ほかは灰色にする', () => {
    const out = highlightOutOfGamut(pixels([[0, 0, 255], [230, 190, 160]]));
    expect([...out.slice(0, 3)]).toEqual([0, 0, 255]);
    expect(out[4]).toBe(out[5]);
    expect(out[5]).toBe(out[6]);
  });
});

describe('くすみ警告: 調べる範囲の限定(CMYK の所は除く)', () => {
  it('印の付いた画素だけを数え、プレビューの変換も印の所だけに行う', async () => {
    const { measureGamut, maskFromRects, simulatePrint } = await import('../../src/print/gamut.ts');
    // 2 × 1 画素の鮮やかな青。左だけを RGB の範囲とする
    const data = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255]);
    const mask = maskFromRects(2, 1, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]);
    expect(measureGamut(data, 2, 1, undefined, mask).pixels).toBe(1);
    const out = simulatePrint(data, mask);
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 255, 255]);
    expect(Array.from(out.slice(0, 4))).not.toEqual([0, 0, 255, 255]);
  });
});
