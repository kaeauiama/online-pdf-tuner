import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from '../print/geometry.ts';

/** ページ座標(pt、左下原点)の矩形を、描画先の画素座標(左上原点)の矩形に変換する */
export function toViewportRect(viewport: PageViewport, r: Rect): { x: number; y: number; w: number; h: number } {
  const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0) as [number, number];
  const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1) as [number, number];
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
