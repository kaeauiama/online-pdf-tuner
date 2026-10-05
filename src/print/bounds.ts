// 描画したページの画素から、白いフチを除いた「中身の範囲」を求める(純粋関数)。
// 入稿修正の「白いフチを取り除いて引き伸ばす」(D-010)で使う。
import { rect, type Rect } from './geometry.ts';
import { INK_THRESHOLD } from './thresholds.ts';

/** RGBA(左上原点)のうち、白でない画素を囲む矩形(画素座標)。中身がなければ null */
export function contentBoundsPx(data: Uint8ClampedArray, width: number, height: number): Rect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 16) continue;
      if (data[i] >= INK_THRESHOLD && data[i + 1] >= INK_THRESHOLD && data[i + 2] >= INK_THRESHOLD) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : rect(x0, y0, x1 + 1, y1 + 1);
}
