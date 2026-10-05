// 入稿修正(M3): 塗り足しの生成・日本式トンボ・TrimBox/BleedBox の設定を行い、入稿用の PDF を作る。
// 元のページは Form XObject として埋め込んで描くため、文字や図形はベクターのまま残る。
// 注釈(コメント・リンク等)は持ち越さない(印刷では使わず、入稿できない印刷所もあるため)。
import {
  clip,
  degrees,
  endPath,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFEmbeddedPage,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { ReasonError } from '../core/reasons.ts';
import { mmToPt, ptToMm, rect, rectHeight, rectWidth, type Rect } from './geometry.ts';
import type { PageLayout } from './layout.ts';
import { drawTrimMarks, MARK_MARGIN_MM } from './marks.ts';

/**
 * 塗り足しのないページに、塗り足しを作る方法
 * - mirror: 端の帯を鏡写しにして外側へ伸ばす
 * - scale: ページ全体を、塗り足しまで覆う大きさに拡大する(端が少し切れる)
 * - region: 白いフチを取り除き、中身を塗り足しまで引き伸ばす(余白付きで作った表紙向け)
 * - none: 塗り足しを付けない(白いフチのデザイン)
 */
export type BleedMethod = 'mirror' | 'scale' | 'region' | 'none';
export type RegionFit = 'cover' | 'stretch';

export interface FixOptions {
  /** 塗り足し(各辺、mm) */
  readonly bleedMm: number;
  /** トンボを付けるか */
  readonly marks: boolean;
  readonly method: BleedMethod;
  /** method を使うページ(0 始まり)。それ以外の塗り足しのないページは 'none' */
  readonly targetPages: ReadonlySet<number> | 'all';
  readonly regionFit: RegionFit;
  /** method = 'region' のとき: ページごとの中身の範囲(pt、ページ座標)。白いフチの内側 */
  readonly contentBounds?: ReadonlyMap<number, Rect>;
}

export interface FixPageResult {
  readonly page: number;
  /** 実際に使った方法(元から塗り足しがあれば 'existing') */
  readonly method: BleedMethod | 'existing';
  /** 利用者に伝える注意(切れる量・変形の大きさなど) */
  readonly notes: readonly string[];
}

export interface FixResult {
  readonly bytes: Uint8Array;
  readonly pages: readonly FixPageResult[];
}

function center(r: Rect): [number, number] {
  return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
}

/** clipRect の内側にだけ、埋め込んだページを描く */
function drawClipped(
  page: PDFPage,
  embedded: PDFEmbeddedPage,
  clipRect: Rect,
  placement: { x: number; y: number; xScale: number; yScale: number },
): void {
  page.pushOperators(pushGraphicsState(), rectangle(clipRect.x0, clipRect.y0, rectWidth(clipRect), rectHeight(clipRect)), clip(), endPath());
  page.drawPage(embedded, placement);
  page.pushOperators(popGraphicsState());
}

/** 端の帯を鏡写しにして塗り足しを作る。trim は新しいページ上の仕上がり位置 */
function drawMirrored(page: PDFPage, embedded: PDFEmbeddedPage, trim: Rect, bleed: Rect): void {
  const w = rectWidth(trim);
  const h = rectHeight(trim);
  // x 方向: [塗り足しの帯, 開始位置, 倍率]。鏡写しは仕上がり線を軸に反転する
  const xs = [
    { band: [bleed.x0, trim.x0], x: trim.x0, scale: -1 },
    { band: [trim.x0, trim.x1], x: trim.x0, scale: 1 },
    { band: [trim.x1, bleed.x1], x: trim.x1 + w, scale: -1 },
  ] as const;
  const ys = [
    { band: [bleed.y0, trim.y0], y: trim.y0, scale: -1 },
    { band: [trim.y0, trim.y1], y: trim.y0, scale: 1 },
    { band: [trim.y1, bleed.y1], y: trim.y1 + h, scale: -1 },
  ] as const;
  for (const xb of xs) {
    for (const yb of ys) {
      if (xb.band[1] - xb.band[0] <= 0 || yb.band[1] - yb.band[0] <= 0) continue;
      drawClipped(page, embedded, rect(xb.band[0], yb.band[0], xb.band[1], yb.band[1]), {
        x: xb.x,
        y: yb.y,
        xScale: xb.scale,
        yScale: yb.scale,
      });
    }
  }
}

function inTarget(options: FixOptions, index: number): boolean {
  return options.targetPages === 'all' || options.targetPages.has(index);
}

export async function buildPrintReady(source: PDFDocument, layouts: readonly PageLayout[], options: FixOptions): Promise<FixResult> {
  const unknown = layouts.findIndex((l) => l.kind === 'unknown');
  if (unknown >= 0) throw new ReasonError('PRINT_FIX_SIZE_UNKNOWN', `${unknown + 1} ページ目`);

  const out = await PDFDocument.create({ updateMetadata: false });
  const b = mmToPt(options.bleedMm);
  const m = options.marks ? mmToPt(MARK_MARGIN_MM) : 0;
  const results: FixPageResult[] = [];

  for (const [i, srcPage] of source.getPages().entries()) {
    const layout = layouts[i];
    const tw = rectWidth(layout.trim);
    const th = rectHeight(layout.trim);
    const page = out.addPage([tw + 2 * (b + m), th + 2 * (b + m)]);
    const trim = rect(m + b, m + b, m + b + tw, m + b + th);
    const bleed = rect(m, m, m + 2 * b + tw, m + 2 * b + th);
    const notes: string[] = [];
    let used: FixPageResult['method'];

    if (layout.bleedMm > 0) {
      // 元から塗り足しがある: 仕上がり位置をそろえて、そのまま置く
      used = 'existing';
      const embedded = await out.embedPage(srcPage, { left: layout.bleed.x0, bottom: layout.bleed.y0, right: layout.bleed.x1, top: layout.bleed.y1 });
      drawClipped(page, embedded, bleed, {
        x: trim.x0 - (layout.trim.x0 - layout.bleed.x0),
        y: trim.y0 - (layout.trim.y0 - layout.bleed.y0),
        xScale: 1,
        yScale: 1,
      });
      if (layout.bleedMm < options.bleedMm - 0.3) notes.push(`元の塗り足しが ${layout.bleedMm.toFixed(1)}mm しかないため、外側は白いままです。`);
    } else {
      const method: BleedMethod = inTarget(options, i) ? options.method : 'none';
      const region = options.contentBounds?.get(i);
      used = method === 'region' && !region ? 'none' : method;
      const trimBox = { left: layout.trim.x0, bottom: layout.trim.y0, right: layout.trim.x1, top: layout.trim.y1 };

      if (used === 'none') {
        const embedded = await out.embedPage(srcPage, trimBox);
        page.drawPage(embedded, { x: trim.x0, y: trim.y0 });
        if (method === 'region') notes.push('中身が見つからなかったため、塗り足しを付けていません。');
      } else if (used === 'mirror') {
        drawMirrored(page, await out.embedPage(srcPage, trimBox), trim, bleed);
      } else if (used === 'scale') {
        const s = Math.max((tw + 2 * b) / tw, (th + 2 * b) / th);
        const [cx, cy] = center(trim);
        drawClipped(page, await out.embedPage(srcPage, trimBox), bleed, { x: cx - (s * tw) / 2, y: cy - (s * th) / 2, xScale: s, yScale: s });
        const cut = Math.max(((s - 1) * tw) / 2, ((s - 1) * th) / 2);
        notes.push(`全体を ${((s - 1) * 100).toFixed(1)}% 拡大しました。仕上がりの端から約 ${ptToMm(cut).toFixed(1)}mm 内側までの絵柄が切れます。`);
      } else {
        // region: 白いフチの内側を、塗り足しの外端まで広げる
        const r = region!;
        const rw = rectWidth(r);
        const rh = rectHeight(r);
        const bw = rectWidth(bleed);
        const bh = rectHeight(bleed);
        const embedded = await out.embedPage(srcPage, { left: r.x0, bottom: r.y0, right: r.x1, top: r.y1 });
        if (options.regionFit === 'stretch') {
          const sx = bw / rw;
          const sy = bh / rh;
          drawClipped(page, embedded, bleed, { x: bleed.x0, y: bleed.y0, xScale: sx, yScale: sy });
          const distortion = Math.abs(sx / sy - 1) * 100;
          if (distortion >= 0.5) notes.push(`縦横比を変えて合わせたため、絵柄が約 ${distortion.toFixed(1)}% ${sx > sy ? '横' : '縦'}に伸びています。`);
        } else {
          const s = Math.max(bw / rw, bh / rh);
          const [cx, cy] = center(bleed);
          drawClipped(page, embedded, bleed, { x: cx - (s * rw) / 2, y: cy - (s * rh) / 2, xScale: s, yScale: s });
          const overX = (s * rw - bw) / 2;
          const overY = (s * rh - bh) / 2;
          const over = Math.max(overX, overY);
          if (ptToMm(over) >= 0.5) notes.push(`縦横比を保ったため、${overX > overY ? '左右' : '上下'}が約 ${ptToMm(over).toFixed(1)}mm ずつはみ出して切れます。`);
        }
        notes.push(`白いフチを取り除き、中身を ${(Math.max(bw / rw, bh / rh) * 100 - 100).toFixed(1)}% 拡大しました。`);
      }
    }

    if (srcPage.getRotation().angle % 360 !== 0) page.setRotation(degrees(srcPage.getRotation().angle));
    page.setTrimBox(trim.x0, trim.y0, tw, th);
    page.setBleedBox(bleed.x0, bleed.y0, rectWidth(bleed), rectHeight(bleed));
    if (options.marks) drawTrimMarks(out, page, trim, bleed);
    results.push({ page: i, method: used, notes });
  }

  return { bytes: await out.save({ useObjectStreams: true }), pages: results };
}

/** 中綴じのために、4 の倍数になるまでに足す白紙の枚数 */
export function blankPagesForSaddle(pageCount: number): number {
  return (4 - (pageCount % 4)) % 4;
}
