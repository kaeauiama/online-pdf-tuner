// pdf.js による描画(サムネイル)。PDF の書き出しには使わない。
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

let worker: Worker | null = null;

// HC-1: ワーカーを blob: URL 経由で生成し、ページの CSP を継承させる。
// 同一オリジンのスクリプト URL から直接 new Worker() すると、ワーカーには(HTTP ヘッダで配信されない)
// <meta> の CSP が効かず、ワーカー内からの外部通信を止められないため。
function ensureWorker(): void {
  if (worker) return;
  const absolute = new URL(workerUrl, document.baseURI).href;
  const blob = new Blob([`import ${JSON.stringify(absolute)};`], { type: 'text/javascript' });
  worker = new Worker(URL.createObjectURL(blob), { type: 'module', name: 'pdfjs' });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
}

function assetUrl(path: string): string {
  return new URL(`pdfjs/${path}/`, document.baseURI).href;
}

export async function openForRender(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  ensureWorker();
  return pdfjs.getDocument({
    // pdf.js はデータをワーカーへ転送(所有権ごと移動)するため、コピーを渡す
    data: bytes.slice(),
    cMapUrl: assetUrl('cmaps'),
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
    // 未埋め込みフォントを PC のフォントで代用しない(見た目が印刷結果と食い違うのを避ける)
    useSystemFonts: false,
  }).promise;
}

/** ページを、長辺が maxSize(CSS px)に収まるように canvas へ描画する */
export async function renderThumbnail(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  maxSize: number,
): Promise<void> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const ratio = window.devicePixelRatio || 1;
  const scale = (maxSize / Math.max(base.width, base.height)) * ratio;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  canvas.style.width = `${Math.round(viewport.width / ratio)}px`;
  canvas.style.height = `${Math.round(viewport.height / ratio)}px`;
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
}
