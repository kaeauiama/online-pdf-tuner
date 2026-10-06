// JPEG を画素にする(ブラウザ)。CMYK 変換(D-035)で、PDF の中の RGB の JPEG 画像を変換するときに使う。
// PDF では画像の色空間は PDF 側の指定で決まるため、JPEG に埋め込まれた ICC プロファイルによる色の変換はしない
// (colorSpaceConversion: 'none'。pdf.js の表示と同じ扱い)。
import type { JpegDecoder } from '../print/colorConvert.ts';

export const decodeJpegInBrowser: JpegDecoder = async (jpeg) => {
  const bitmap = await createImageBitmap(new Blob([jpeg.slice()], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    canvas.width = 0;
    canvas.height = 0;
    return { data, width: bitmap.width, height: bitmap.height, channels: 4 };
  } finally {
    bitmap.close();
  }
};
