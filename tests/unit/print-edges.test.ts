import { describe, expect, it } from 'vitest';
import { displayedSide, scanEdges, type Side, type SideStats } from '../../src/print/edges.ts';
import { rect } from '../../src/print/geometry.ts';

const PX_PER_MM = 4;

/** w×h mm の白い画像を作り、fill(x, y) が true の画素を色で塗る */
function image(wMm: number, hMm: number, fill: (xMm: number, yMm: number) => boolean) {
  const width = wMm * PX_PER_MM;
  const height = hMm * PX_PER_MM;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fill(x / PX_PER_MM, y / PX_PER_MM)) data.set([30, 60, 160, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const bySide = (stats: SideStats[]) => Object.fromEntries(stats.map((s) => [s.side, s])) as Record<Side, SideStats>;
const ratio = (s: SideStats) => s.missingBleed / s.samples;

describe('scanEdges', () => {
  it('塗り足しなし・端まで色: すべての辺で塗り足し不足', () => {
    const img = image(50, 70, () => true);
    const s = bySide(scanEdges({ ...img, trimPx: rect(0, 0, img.width, img.height), pxPerMm: PX_PER_MM }));
    for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(ratio(s[side])).toBeGreaterThan(0.9);
  });

  it('塗り足しなし・白いフチあり: 問題なし', () => {
    const img = image(50, 70, (x, y) => x > 5 && x < 45 && y > 5 && y < 65);
    const s = scanEdges({ ...img, trimPx: rect(0, 0, img.width, img.height), pxPerMm: PX_PER_MM });
    expect(s.every((x) => x.inkAtTrim === 0 && x.missingBleed === 0)).toBe(true);
  });

  it('塗り足し 3mm まで背景がある: 問題なし', () => {
    const img = image(56, 76, () => true);
    const trim = rect(3 * PX_PER_MM, 3 * PX_PER_MM, 53 * PX_PER_MM, 73 * PX_PER_MM);
    const s = scanEdges({ ...img, trimPx: trim, pxPerMm: PX_PER_MM });
    expect(s.every((x) => x.inkAtTrim > 0 && x.missingBleed === 0)).toBe(true);
  });

  it('背景が仕上がり線で止まっている(塗り足しが白い): 塗り足し不足', () => {
    const img = image(56, 76, (x, y) => x >= 3 && x < 53 && y >= 3 && y < 73);
    const trim = rect(3 * PX_PER_MM, 3 * PX_PER_MM, 53 * PX_PER_MM, 73 * PX_PER_MM);
    const s = bySide(scanEdges({ ...img, trimPx: trim, pxPerMm: PX_PER_MM }));
    for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(ratio(s[side])).toBeGreaterThan(0.9);
  });

  it('上の帯だけ端まで色がある場合は、上の辺だけを指摘する', () => {
    // 上 20mm の帯は塗り足しまで、それ以外は白
    const img = image(56, 76, (_, y) => y < 23);
    const trim = rect(3 * PX_PER_MM, 3 * PX_PER_MM, 53 * PX_PER_MM, 73 * PX_PER_MM);
    const s = bySide(scanEdges({ ...img, trimPx: trim, pxPerMm: PX_PER_MM }));
    expect(s.top.missingBleed).toBe(0);
    expect(s.top.inkAtTrim).toBeGreaterThan(0);
    expect(s.bottom.inkAtTrim).toBe(0);
    // 左右の辺は上の一部だけ色があり、塗り足しまで届いている
    expect(s.left.missingBleed).toBe(0);
  });

  it('半透明(アルファが小さい)画素は紙の白とみなす', () => {
    const img = image(50, 70, () => true);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
    const s = scanEdges({ ...img, trimPx: rect(0, 0, img.width, img.height), pxPerMm: PX_PER_MM });
    expect(s.every((x) => x.inkAtTrim === 0)).toBe(true);
  });
});

describe('displayedSide', () => {
  it('ページの回転に合わせて辺を読み替える', () => {
    expect(displayedSide('top', 0)).toBe('top');
    expect(displayedSide('top', 90)).toBe('right');
    expect(displayedSide('left', 90)).toBe('top');
    expect(displayedSide('bottom', 180)).toBe('top');
    expect(displayedSide('right', 270)).toBe('top');
  });
});
