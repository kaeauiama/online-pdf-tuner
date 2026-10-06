// 画像 → PDF(M5)。JPEG / PNG を 1 枚 1 ページにする。
// 画像の読み込み(EXIF の向きの反映、JPEG / PNG 以外の変換)は app 側(ブラウザ)で行い、ここには JPEG / PNG のバイト列を渡す。
import { PDFDocument } from '@cantoo/pdf-lib';
import { mmToPt } from '../print/geometry.ts';

export interface ImageInput {
  readonly bytes: Uint8Array;
  readonly kind: 'jpg' | 'png';
}

/**
 * - a4: A4 に収める(画像の縦横に合わせて向きを決める)
 * - image: 画像の画素数を 350ppi とみなした大きさのページにする
 */
export type ImagePageSize = 'a4' | 'image';

export interface ImagesToPdfOptions {
  readonly pageSize: ImagePageSize;
  readonly marginMm: number;
}

/** 画像の画素数を、この解像度とみなしてページの大きさを決める(pageSize = 'image') */
export const IMAGE_PAGE_DPI = 350;

const A4 = { w: mmToPt(210), h: mmToPt(297) };

export async function imagesToPdf(images: readonly ImageInput[], options: ImagesToPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const margin = mmToPt(options.marginMm);
  for (const img of images) {
    const embedded = img.kind === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
    const landscape = embedded.width > embedded.height;
    let pageW: number;
    let pageH: number;
    if (options.pageSize === 'a4') {
      [pageW, pageH] = landscape ? [A4.h, A4.w] : [A4.w, A4.h];
    } else {
      pageW = (embedded.width / IMAGE_PAGE_DPI) * 72 + margin * 2;
      pageH = (embedded.height / IMAGE_PAGE_DPI) * 72 + margin * 2;
    }
    const page = doc.addPage([pageW, pageH]);
    // 余白の内側に、縦横比を保って収める
    const scale = Math.min((pageW - margin * 2) / embedded.width, (pageH - margin * 2) / embedded.height);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawImage(embedded, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
  }
  return doc.save({ useObjectStreams: true });
}

/**
 * JPEG の EXIF の向き(1〜8)を読む。読めなければ 1(そのまま)。
 * スマートフォンの写真は、画素は横向きのまま「向き」だけ EXIF に書かれていることが多い
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= dv.byteLength) {
    const marker = dv.getUint16(offset);
    const length = dv.getUint16(offset + 2);
    if (marker === 0xffe1 && dv.getUint32(offset + 4) === 0x45786966 /* Exif */) {
      const tiff = offset + 10;
      const little = dv.getUint16(tiff) === 0x4949;
      const u16 = (o: number) => dv.getUint16(o, little);
      const u32 = (o: number) => dv.getUint32(o, little);
      const ifd = tiff + u32(tiff + 4);
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > dv.byteLength) return 1;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1; // 画像データに入ったら終わり
    offset += 2 + length;
  }
  return 1;
}
