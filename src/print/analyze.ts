// 入稿チェックの実行(ブラウザ)。構造の解析(pdf-lib)、文字の位置と端の色(pdf.js)を集めて runChecks に渡す。
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { openForRender } from '../render/pdfjs.ts';
import { toViewportRect } from '../render/viewport.ts';
import { runChecks, type CheckOptions, type PageFacts, type PrintReport } from './checks.ts';
import { scanEdges, type SideStats } from './edges.ts';
import { contentBoundsPx } from './bounds.ts';
import { maskFromRects, measureGamut } from './gamut.ts';
import { PT_PER_MM, rect, type Rect } from './geometry.ts';
import { resolveLayout } from './layout.ts';
import { scanStructure } from './structure.ts';
import { textItemToBox, type TextBox, type TextItemLike } from './textBoxes.ts';
import { EDGE_RENDER_PX_PER_MM } from './thresholds.ts';

export interface PrintAnalysis {
  readonly report: PrintReport;
  readonly facts: readonly PageFacts[];
  /** プレビュー描画用 */
  readonly renderDoc: PDFDocumentProxy;
  /** 解析した PDF(入稿修正の入力にする) */
  readonly bytes: Uint8Array;
}

export async function analyzeForPrint(
  bytes: Uint8Array,
  options: CheckOptions,
  progress: (text: string) => void,
): Promise<PrintAnalysis> {
  const doc = await loadPdfForEditOrThrow(bytes);
  const structures = scanStructure(doc);
  const renderDoc = await openForRender(bytes);

  const facts: PageFacts[] = [];
  for (const [i, structure] of structures.entries()) {
    progress(`ページを調べています…(${i + 1} / ${structures.length})`);
    const page = await renderDoc.getPage(i + 1);
    const layout = resolveLayout(structure, options.profile, options.paper);

    const content = await page.getTextContent();
    const textBoxes: TextBox[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const vertical = content.styles[item.fontName]?.vertical ?? false;
      const box = textItemToBox(item as TextItemLike, vertical);
      if (box) textBoxes.push(box);
    }

    // 端の色: 回転なしで描画し、仕上がり位置を画素座標に写して調べる
    const viewport = page.getViewport({ scale: EDGE_RENDER_PX_PER_MM / PT_PER_MM, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const toPxRect = (r: Rect): Rect => {
      const v = toViewportRect(viewport, r);
      return rect(v.x, v.y, v.x + v.w, v.y + v.h);
    };
    const trimPx = toPxRect(layout.trim);
    const edges: SideStats[] = scanEdges({
      data: image.data,
      width: image.width,
      height: image.height,
      trimPx,
      bleedPx: toPxRect(layout.bleed),
      pxPerMm: EDGE_RENDER_PX_PER_MM,
    });
    // くすみ警告: 仕上がりの内側(実際に印刷に残る部分)のうち、RGB で描いた所だけを調べる
    // (CMYK の色はインキの指定そのものなので、変換でくすむことはない)
    const areas = structure.rgbAreas;
    const gamut =
      areas === 'all'
        ? measureGamut(image.data, image.width, image.height, trimPx)
        : areas.length === 0
          ? { pixels: 0, moderate: 0, strong: 0 }
          : measureGamut(image.data, image.width, image.height, trimPx, maskFromRects(image.width, image.height, areas.map(toPxRect)));
    // 入稿修正(白いフチを取り除く)用: 中身の範囲をページ座標に戻す
    const boundsPx = contentBoundsPx(image.data, image.width, image.height);
    let contentBounds: Rect | undefined;
    if (boundsPx) {
      const [ax, ay] = viewport.convertToPdfPoint(boundsPx.x0, boundsPx.y0) as [number, number];
      const [bx, by] = viewport.convertToPdfPoint(boundsPx.x1, boundsPx.y1) as [number, number];
      contentBounds = rect(ax, ay, bx, by);
    }
    page.cleanup();
    facts.push({ structure, textBoxes, edges, gamut, contentBounds });
  }

  return { report: runChecks(facts, options), facts, renderDoc, bytes };
}
