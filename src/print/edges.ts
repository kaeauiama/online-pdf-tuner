// 描画したページの画素から、仕上がり線の付近に色があるか・塗り足しが白く抜けていないかを調べる(純粋関数)。
import type { Rect } from './geometry.ts';
import { INK_THRESHOLD } from './thresholds.ts';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export interface EdgeScanInput {
  /** RGBA、左上原点 */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** 仕上がり位置(画素座標、左上原点。x0,y0 が左上) */
  readonly trimPx: Rect;
  /** 塗り足しの外端(画素座標)。省略時は画像全体。トンボ付きのページでは、その外側は白い余白 */
  readonly bleedPx?: Rect;
  readonly pxPerMm: number;
}

export interface SideStats {
  readonly side: Side;
  /** 調べた位置の数 */
  readonly samples: number;
  /** 仕上がり線のすぐ内側に色がある位置の数 */
  readonly inkAtTrim: number;
  /** 仕上がり線の内側に色があるのに、外側(塗り足し)が白い位置の数。塗り足しがなければ inkAtTrim と同じ */
  readonly missingBleed: number;
}

function inked(input: EdgeScanInput, x: number, y: number): boolean {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= input.width || yi >= input.height) return false;
  const i = (yi * input.width + xi) * 4;
  const a = input.data[i + 3];
  if (a < 16) return false; // 透明は紙の白とみなす
  return input.data[i] < INK_THRESHOLD || input.data[i + 1] < INK_THRESHOLD || input.data[i + 2] < INK_THRESHOLD;
}

export function scanEdges(input: EdgeScanInput): SideStats[] {
  const { trimPx: t, pxPerMm } = input;
  // 内側: 仕上がり線から 0.5mm と 1mm 内側。外側: 1mm 外側と、ページ端の 0.5mm 手前
  const inner = [0.5 * pxPerMm, 1 * pxPerMm];
  const outer = [1 * pxPerMm];
  const skip = 1.5 * pxPerMm; // 角の付近は調べない(角丸や斜めの線の影響を避ける)

  const result: SideStats[] = [];
  for (const side of SIDES) {
    const horizontal = side === 'top' || side === 'bottom';
    const from = (horizontal ? t.x0 : t.y0) + skip;
    const to = (horizontal ? t.x1 : t.y1) - skip;
    // 仕上がり線から外向きの単位ベクトル
    const [dx, dy] = side === 'top' ? [0, -1] : side === 'bottom' ? [0, 1] : side === 'left' ? [-1, 0] : [1, 0];
    const edgeX = side === 'left' ? t.x0 : side === 'right' ? t.x1 : 0;
    const edgeY = side === 'top' ? t.y0 : side === 'bottom' ? t.y1 : 0;
    // 塗り足しの外端までの距離(塗り足しの幅、画素)
    const b = input.bleedPx ?? { x0: 0, y0: 0, x1: input.width, y1: input.height };
    const room = side === 'top' ? t.y0 - b.y0 : side === 'left' ? t.x0 - b.x0 : side === 'bottom' ? b.y1 - t.y1 : b.x1 - t.x1;
    const hasBleed = room >= 1 * pxPerMm;
    const outerDepths = hasBleed ? [...outer, Math.max(outer[0], room - 0.5 * pxPerMm)] : [];

    let samples = 0;
    let inkAtTrim = 0;
    let missingBleed = 0;
    for (let p = from; p <= to; p += 1) {
      const bx = horizontal ? p : edgeX;
      const by = horizontal ? edgeY : p;
      samples++;
      const inside = inner.some((d) => inked(input, bx - dx * d, by - dy * d));
      if (!inside) continue;
      inkAtTrim++;
      if (!hasBleed || outerDepths.some((d) => !inked(input, bx + dx * d, by + dy * d))) missingBleed++;
    }
    result.push({ side, samples, inkAtTrim, missingBleed });
  }
  return result;
}

/** ページの回転(時計回り)を考慮して、回転前の辺を「画面上でどの辺に見えるか」に変換する */
export function displayedSide(side: Side, rotation: number): Side {
  const steps = (((rotation / 90) % 4) + 4) % 4;
  return SIDES[(SIDES.indexOf(side) + steps) % 4];
}
