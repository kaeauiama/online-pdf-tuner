// ページの「仕上がり位置」を決める。TrimBox があればそれを使い、なければページの寸法から推定する。
import { insetRect, mmToPt, ptToMm, rect, rectHeight, rectWidth, type Rect } from './geometry.ts';
import { PAPER_SIZES, SIZE_TOLERANCE_MM, type PaperSize } from './paperSizes.ts';
import type { PrintProfile } from './profiles.ts';
import type { PageStructure } from './structure.ts';
import { BLEED_DETECT_MAX_MM, BLEED_DETECT_MIN_MM } from './thresholds.ts';

/**
 * - trimbox: PDF に仕上がり位置(TrimBox)が書かれている
 * - trim: ページ = 仕上がりサイズ(塗り足しなし)
 * - trim+bleed: ページ = 仕上がりサイズ + 塗り足し
 * - unknown: 仕上がりサイズが分からない(ページ全体を仕上がりとみなして続行)
 */
export type LayoutKind = 'trimbox' | 'trim' | 'trim+bleed' | 'unknown';

export interface PageLayout {
  readonly kind: LayoutKind;
  readonly paper?: PaperSize;
  readonly landscape: boolean;
  /** 表示範囲(ページの外枠) */
  readonly page: Rect;
  /** 仕上がり位置(断裁位置) */
  readonly trim: Rect;
  /** 塗り足しの外端 */
  readonly bleed: Rect;
  /** 安全領域(文字はこの内側に) */
  readonly safe: Rect;
  /** 塗り足しの最小幅(mm)。塗り足しがなければ 0 */
  readonly bleedMm: number;
}

export type PaperChoice = 'auto' | PaperSize;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= SIZE_TOLERANCE_MM;
}

function intersect(a: Rect, b: Rect): Rect {
  return rect(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1));
}

function minMargin(outer: Rect, inner: Rect): number {
  return ptToMm(Math.min(inner.x0 - outer.x0, inner.y0 - outer.y0, outer.x1 - inner.x1, outer.y1 - inner.y1));
}

function matchPaper(widthMm: number, heightMm: number, candidates: readonly PaperSize[]): { paper: PaperSize; landscape: boolean } | undefined {
  for (const paper of candidates) {
    if (near(widthMm, paper.widthMm) && near(heightMm, paper.heightMm)) return { paper, landscape: false };
    if (near(widthMm, paper.heightMm) && near(heightMm, paper.widthMm)) return { paper, landscape: true };
  }
  return undefined;
}

function matchPaperWithBleed(
  widthMm: number,
  heightMm: number,
  candidates: readonly PaperSize[],
): { paper: PaperSize; landscape: boolean; marginX: number; marginY: number } | undefined {
  const inRange = (m: number) => m >= BLEED_DETECT_MIN_MM - 0.05 && m <= BLEED_DETECT_MAX_MM + 0.05;
  for (const paper of candidates) {
    for (const landscape of [false, true]) {
      const pw = landscape ? paper.heightMm : paper.widthMm;
      const ph = landscape ? paper.widthMm : paper.heightMm;
      const marginX = (widthMm - pw) / 2;
      const marginY = (heightMm - ph) / 2;
      if (inRange(marginX) && inRange(marginY) && Math.abs(marginX - marginY) <= SIZE_TOLERANCE_MM) {
        return { paper, landscape, marginX, marginY };
      }
    }
  }
  return undefined;
}

export function resolveLayout(page: PageStructure, profile: PrintProfile, choice: PaperChoice): PageLayout {
  const visible = intersect(page.cropBox, page.mediaBox);
  const safeOf = (trim: Rect) => insetRect(trim, mmToPt(profile.safeMarginMm));
  const candidates = choice === 'auto' ? PAPER_SIZES : [choice];

  if (page.trimBox) {
    const trim = intersect(page.trimBox, visible);
    const bleed = page.bleedBox ? intersect(page.bleedBox, visible) : visible;
    const m = matchPaper(ptToMm(rectWidth(trim)), ptToMm(rectHeight(trim)), candidates);
    return {
      kind: 'trimbox',
      paper: m?.paper,
      landscape: m?.landscape ?? rectWidth(trim) > rectHeight(trim),
      page: visible,
      trim,
      bleed,
      safe: safeOf(trim),
      bleedMm: Math.max(0, minMargin(bleed, trim)),
    };
  }

  const w = ptToMm(rectWidth(visible));
  const h = ptToMm(rectHeight(visible));
  const exact = matchPaper(w, h, candidates);
  if (exact) {
    return { kind: 'trim', ...exact, page: visible, trim: visible, bleed: visible, safe: safeOf(visible), bleedMm: 0 };
  }
  const withBleed = matchPaperWithBleed(w, h, candidates);
  if (withBleed) {
    const trim = rect(
      visible.x0 + mmToPt(withBleed.marginX),
      visible.y0 + mmToPt(withBleed.marginY),
      visible.x1 - mmToPt(withBleed.marginX),
      visible.y1 - mmToPt(withBleed.marginY),
    );
    return {
      kind: 'trim+bleed',
      paper: withBleed.paper,
      landscape: withBleed.landscape,
      page: visible,
      trim,
      bleed: visible,
      safe: safeOf(trim),
      bleedMm: Math.min(withBleed.marginX, withBleed.marginY),
    };
  }
  return { kind: 'unknown', landscape: w > h, page: visible, trim: visible, bleed: visible, safe: safeOf(visible), bleedMm: 0 };
}
