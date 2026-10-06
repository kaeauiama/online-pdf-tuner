// 効果の焼き込み(ブラウザ): 文字以外の層を pdf.js で描画して画像にし、元のページを「画像 + 文字だけの層」に置き換える。
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, type PDFPage } from '@cantoo/pdf-lib';
import { AnnotationMode } from 'pdfjs-dist';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { lexContent } from '../pdf/lexer.ts';
import { openForRender } from '../render/pdfjs.ts';
import { flattenScale, splitTextLayers, type GsInfo } from './flatten.ts';
import { pageContentBytes, streamBytes } from './structure.ts';

/** JPEG の品質(0〜1)。写真と図形が混ざるページで、にじみが目立たない程度に高くする */
const JPEG_QUALITY = 0.95;

export interface FlattenedPage {
  readonly page: number;
  /** 実際に描画した解像度(上限を超えて下げた場合は小さくなる) */
  readonly dpi: number;
  /** フォームの中に文字があった(その文字は画像になった) */
  readonly textInForms: boolean;
  /** 見えない文字(描画モード 3)に置き換えた、完全に透明な文字の数 */
  readonly invisibleText: number;
  /** 効果ごと画像に焼き込んだ、半透明などの文字の数 */
  readonly rasterizedText: number;
}

/** ページの ExtGState から、透明に関わる値を読む */
function extGStateReader(page: PDFPage): (name: string) => GsInfo | undefined {
  const dict = page.node.Resources()?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  return (name) => {
    const gs = dict?.lookupMaybe(PDFName.of(name), PDFDict);
    if (!gs) return undefined;
    const number = (key: string) => {
      const v = gs.lookup(PDFName.of(key));
      return v instanceof PDFNumber ? v.asNumber() : undefined;
    };
    const smask = gs.lookup(PDFName.of('SMask'));
    const bm = gs.lookup(PDFName.of('BM'));
    const mode = bm instanceof PDFArray ? bm.lookup(0) : bm;
    return {
      fillAlpha: number('ca'),
      strokeAlpha: number('CA'),
      softMask: smask === undefined ? undefined : smask instanceof PDFDict,
      blend: mode instanceof PDFName ? !['Normal', 'Compatible'].includes(mode.decodeText()) : undefined,
    };
  };
}

export interface FlattenResult {
  readonly bytes: Uint8Array;
  readonly pages: readonly FlattenedPage[];
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** ページが使うフォーム XObject の中に、文字の命令があるか(1 段だけ見る) */
function formsContainText(doc: PDFDocument, pageIndex: number): boolean {
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjects) return false;
  for (const [, ref] of xobjects.entries()) {
    const x = doc.context.lookup(ref);
    if (!(x instanceof PDFStream) || x.dict.get(PDFName.of('Subtype'))?.toString() !== '/Form') continue;
    try {
      if (lexContent(streamBytes(x)).some((o) => o.op === 'Tj' || o.op === 'TJ' || o.op === "'" || o.op === '"')) return true;
    } catch {
      return true; // 読めなければ、あるものとして扱う(利用者への注意を出す側に倒す)
    }
  }
  return false;
}

export async function flattenPdf(
  bytes: Uint8Array,
  targetPages: ReadonlySet<number>,
  dpi: number,
  progress: (text: string) => void,
): Promise<FlattenResult> {
  const doc = await loadPdfForEditOrThrow(bytes);
  const results: FlattenedPage[] = [];
  const targets = [...targetPages].sort((a, b) => a - b);

  for (const [k, i] of targets.entries()) {
    progress(`効果を焼き込んでいます…(${k + 1} / ${targets.length})`);
    const page = doc.getPage(i);
    const layers = splitTextLayers(pageContentBytes(doc, page), extGStateReader(page));

    // 1. 文字以外の層だけのページを作って描画する
    const tmp = await PDFDocument.create({ updateMetadata: false });
    const [copy] = await tmp.copyPages(doc, [i]);
    tmp.addPage(copy);
    copy.node.set(PDFName.of('Contents'), tmp.context.register(tmp.context.flateStream(layers.noText)));
    const renderDoc = await openForRender(await tmp.save());
    const pdfPage = await renderDoc.getPage(1);
    const [x0, y0, x1, y1] = pdfPage.view;
    const { scale, dpi: actualDpi } = flattenScale(x1 - x0, y1 - y0, dpi);
    const viewport = pdfPage.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // 注釈は焼き込まない(入稿用 PDF では注釈を持ち越さない方針と合わせる)
    await pdfPage.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
    const jpeg = await canvasToJpeg(canvas);
    canvas.width = 0;
    canvas.height = 0;
    await renderDoc.loadingTask.destroy();

    // 2. 元のページを「画像(下) + 文字だけの層(上)」に置き換える
    const image = await doc.embedJpg(jpeg);
    const name = page.node.newXObject('FlattenedBackground', image.ref);
    const background = new TextEncoder().encode(`q ${x1 - x0} 0 0 ${y1 - y0} ${x0} ${y0} cm ${name.toString()} Do Q\n`);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(concat(background, layers.textOnly))));
    results.push({
      page: i,
      dpi: actualDpi,
      textInForms: formsContainText(doc, i),
      invisibleText: layers.invisibleText,
      rasterizedText: layers.rasterizedText,
    });
  }

  return { bytes: await doc.save({ useObjectStreams: true }), pages: results };
}
