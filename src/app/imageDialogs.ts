// 画像 ⇔ PDF(M5)。画像を読み込むときの設定ダイアログと、ページを画像で保存するダイアログ。
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { baseName, zipFiles, type NamedFile } from '../core/build.ts';
import { jpegOrientation, type ImageInput, type ImagesToPdfOptions } from '../core/images.ts';
import { normalizeRotation, type SourceId } from '../core/pageList.ts';
import { flattenScale } from '../print/flatten.ts';
import { openForRender } from '../render/pdfjs.ts';
import { downloadBytes } from './download.ts';
import type { Store } from './store.ts';
import { $, type Ui } from './ui.ts';

export const IMAGE_ACCEPT = /\.(jpe?g|png|webp|gif|bmp)$/i;

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_ACCEPT.test(file.name);
}

function canvasToBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality = 0.95): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('toBlob failed'))), type, quality);
  });
}

/**
 * 画像を、PDF に埋め込める JPEG / PNG にする。
 * 向き情報(EXIF)付きの JPEG と、JPEG / PNG 以外の形式は、ブラウザで描き直す
 */
export async function decodeImage(file: File): Promise<ImageInput> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isJpeg && jpegOrientation(bytes) === 1) return { bytes, kind: 'jpg' };
  if (isPng) return { bytes, kind: 'png' };
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return isJpeg ? { bytes: await canvasToBytes(canvas, 'image/jpeg'), kind: 'jpg' } : { bytes: await canvasToBytes(canvas, 'image/png'), kind: 'png' };
}

/** 画像を読み込むときの設定を聞く。キャンセルなら null */
export function setupImageImport(): (count: number) => Promise<ImagesToPdfOptions | null> {
  const dialog = $<HTMLDialogElement>('#image-import-dialog');
  const form = $<HTMLFormElement>('#image-import-form');
  const lead = $<HTMLElement>('#image-import-lead');
  let resolver: ((v: ImagesToPdfOptions | null) => void) | null = null;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    resolver?.({ pageSize: data.get('pageSize') === 'image' ? 'image' : 'a4', marginMm: Number(data.get('margin') ?? 0) });
    resolver = null;
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    resolver?.(null);
    resolver = null;
  });

  return (count) =>
    new Promise((resolve) => {
      resolver = resolve;
      lead.textContent = `${count} 枚の画像を、1 枚 1 ページの PDF にします。`;
      dialog.showModal();
    });
}

export function setupImageExport(store: Store, ui: Ui): void {
  const dialog = $<HTMLDialogElement>('#image-export-dialog');
  const form = $<HTMLFormElement>('#image-export-form');
  const error = $<HTMLElement>('#image-export-error');

  $<HTMLButtonElement>('[data-action="open-export-images"]').addEventListener('click', () => {
    error.textContent = '';
    const selected = form.querySelector<HTMLInputElement>('input[name="target"][value="selected"]')!;
    selected.disabled = store.selection.size === 0;
    if (selected.disabled) form.querySelector<HTMLInputElement>('input[name="target"][value="all"]')!.checked = true;
    dialog.showModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const type = data.get('format') === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = type === 'image/jpeg' ? 'jpg' : 'png';
    const dpi = Number(data.get('dpi') ?? 300);
    const pages = store.pages.map((ref, i) => ({ ref, n: i + 1 })).filter(({ ref }) => data.get('target') !== 'selected' || store.selection.has(ref.key));
    if (pages.length === 0) {
      error.textContent = 'ページがありません。';
      return;
    }
    dialog.close();
    const first = store.activeSources()[0];
    const base = first ? baseName(first.name) : 'document';

    void ui.run('画像にしています…', async (progress) => {
      const docs = new Map<SourceId, PDFDocumentProxy>();
      const files: NamedFile[] = [];
      try {
        for (const [k, { ref, n }] of pages.entries()) {
          progress(`画像にしています…(${k + 1} / ${pages.length})`);
          let doc = docs.get(ref.sourceId);
          if (!doc) {
            doc = await openForRender(store.sources.get(ref.sourceId)!.bytes);
            docs.set(ref.sourceId, doc);
          }
          const page = await doc.getPage(ref.pageIndex + 1);
          const base1 = page.getViewport({ scale: 1 });
          const { scale } = flattenScale(base1.width, base1.height, dpi);
          const viewport = page.getViewport({ scale, rotation: normalizeRotation(page.rotate + ref.rotation) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport }).promise;
          files.push({ name: `${base}_p${n}.${ext}`, bytes: await canvasToBytes(canvas, type) });
          canvas.width = 0;
          page.cleanup();
        }
      } finally {
        for (const d of docs.values()) await d.loadingTask.destroy();
      }
      if (files.length === 1) {
        downloadBytes(files[0].bytes, files[0].name, type);
        ui.toast(`「${files[0].name}」を保存しました。`);
      } else {
        const zipName = `${base}_画像.zip`;
        downloadBytes(zipFiles(files), zipName, 'application/zip');
        ui.toast(`${files.length} 枚の画像を「${zipName}」にまとめて保存しました。`);
      }
    });
  });
}
