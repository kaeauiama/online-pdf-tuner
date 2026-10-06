// 長さの単位変換と、矩形・行列の計算。PDF の座標は pt(1/72 インチ)、左下原点。

export const PT_PER_MM = 72 / 25.4;
export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt / PT_PER_MM;

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({
  x0: Math.min(x0, x1),
  y0: Math.min(y0, y1),
  x1: Math.max(x0, x1),
  y1: Math.max(y0, y1),
});

export const rectWidth = (r: Rect): number => r.x1 - r.x0;
export const rectHeight = (r: Rect): number => r.y1 - r.y0;

export function insetRect(r: Rect, d: number): Rect {
  return { x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d };
}

export function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x0 >= outer.x0 - tolerance &&
    inner.y0 >= outer.y0 - tolerance &&
    inner.x1 <= outer.x1 + tolerance &&
    inner.y1 <= outer.y1 + tolerance
  );
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** PDF の変換行列 [a b c d e f] */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 を適用してから m2 を適用する行列(PDF の cm は「新しい行列 × 現在の CTM」) */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** 逆行列。退化している(大きさ 0 の)行列なら undefined */
export function invert(m: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return undefined;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** 矩形を行列で写した先の外接矩形 */
export function transformRect(m: Matrix, r: Rect): Rect {
  const pts = [applyToPoint(m, r.x0, r.y0), applyToPoint(m, r.x1, r.y0), applyToPoint(m, r.x0, r.y1), applyToPoint(m, r.x1, r.y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

export function unionRect(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x0 < r.x1 && r.y0 < r.y1 ? r : undefined;
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 単位正方形(画像の描画範囲)を行列で写した先の外接矩形 */
export function unitSquareBounds(m: Matrix): Rect {
  const pts = [applyToPoint(m, 0, 0), applyToPoint(m, 1, 0), applyToPoint(m, 0, 1), applyToPoint(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/** 行列が単位正方形の各辺をどれだけの長さ(pt)に写すか(画像の表示サイズ) */
export function unitSquareSize(m: Matrix): { width: number; height: number } {
  return { width: Math.hypot(m[0], m[1]), height: Math.hypot(m[2], m[3]) };
}
