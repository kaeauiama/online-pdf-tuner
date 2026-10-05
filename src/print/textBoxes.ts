// pdf.js の getTextContent の結果を、ページ座標の矩形に変換する(純粋関数)。
import { rect, type Rect } from './geometry.ts';

export interface TextItemLike {
  readonly str: string;
  /** [a b c d e f]: 文字列の原点と向き・大きさ(ページ座標) */
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

export interface TextBox {
  readonly text: string;
  readonly rect: Rect;
}

// 字面の上下: 基準線から下に 15%、上に 85%(和文フォントの目安)
const DESCENT = 0.15;
const ASCENT = 0.85;

export function textItemToBox(item: TextItemLike, vertical: boolean): TextBox | undefined {
  if (item.str.trim() === '' || item.width <= 0) return undefined;
  const [a, b, , , e, f] = item.transform;
  const size = item.height > 0 ? item.height : Math.hypot(a, b);
  if (vertical) {
    // 縦書き: 原点から下へ width だけ進む。字面は原点を中心に左右へ広がる
    return { text: item.str, rect: rect(e - size / 2, f - item.width, e + size / 2, f) };
  }
  const len = Math.hypot(a, b) || 1;
  const ux = a / len;
  const uy = b / len;
  const vx = -uy;
  const vy = ux;
  const corners: [number, number][] = [
    [0, -DESCENT * size],
    [item.width, -DESCENT * size],
    [0, ASCENT * size],
    [item.width, ASCENT * size],
  ].map(([s, t]) => [e + ux * s + vx * t, f + uy * s + vy * t]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { text: item.str, rect: rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)) };
}
