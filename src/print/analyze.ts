// 入稿チェックの実行(ブラウザ)。構造の解析(pdf-lib)、文字の位置と端の色(pdf.js)を集めて runChecks に渡す。
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { openForRender } from '../render/pdfjs.ts';
import { toViewportRect } from '../render/viewport.ts';
import { runChecks, type CheckOptions, type PageFacts, type PrintReport } from './checks.ts';
import { scanEdges, type SideStats } from './edges.ts';
import { measureGamut } from './gamut.ts';
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
    const t = toViewportRect(viewport, layout.trim);
    const trimPx: Rect = rect(t.x, t.y, t.x + t.w, t.y + t.h);
    const edges: SideStats[] = scanEdges({
      data: image.data,
      width: image.width,
      height: image.height,
      trimPx,
      pxPerMm: EDGE_RENDER_PX_PER_MM,
    });
    // くすみ警告: 仕上がりの内側(実際に印刷に残る部分)だけを調べる
    const gamut = measureGamut(image.data, image.width, image.height, trimPx);
    page.cleanup();
    facts.push({ structure, textBoxes, edges, gamut });
  }

  return { report: runChecks(facts, options), facts, renderDoc };
}
