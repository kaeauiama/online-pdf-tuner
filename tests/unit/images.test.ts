import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { imagesToPdf, jpegOrientation } from '../../src/core/images.ts';
import { ptToMm } from '../../src/print/geometry.ts';
import { scanStructure } from '../../src/print/structure.ts';
import { makePng } from './png.ts';

const sizes = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((p) => [Math.round(ptToMm(p.getWidth())), Math.round(ptToMm(p.getHeight()))]);

describe('imagesToPdf', () => {
  it('A4 に収める: 横長の画像は A4 横、縦長は A4 縦。1 枚 1 ページ', async () => {
    const bytes = await imagesToPdf(
      [
        { bytes: makePng(300, 200, [200, 0, 0]), kind: 'png' },
        { bytes: makePng(200, 300, [0, 200, 0]), kind: 'png' },
      ],
      { pageSize: 'a4', marginMm: 0 },
    );
    expect(await sizes(bytes)).toEqual([
      [297, 210],
      [210, 297],
    ]);
  });

  it('余白を取り、縦横比を保って中央に置く', async () => {
    const bytes = await imagesToPdf([{ bytes: makePng(400, 400, [0, 0, 200]), kind: 'png' }], { pageSize: 'a4', marginMm: 10 });
    const [s] = scanStructure(await PDFDocument.load(bytes));
    const b = s.images[0].bounds;
    expect(Math.round(ptToMm(b.x1 - b.x0))).toBe(190);
    expect(Math.round(ptToMm(b.x0))).toBe(10);
    expect(Math.round(ptToMm(b.y0))).toBe(Math.round((297 - 190) / 2));
  });

  it('画像の大きさ: 画素数を 350ppi とみなしたページにする', async () => {
    const bytes = await imagesToPdf([{ bytes: makePng(3500, 1750, [0, 0, 0]), kind: 'png' }], { pageSize: 'image', marginMm: 0 });
    expect(await sizes(bytes)).toEqual([[254, 127]]);
  });
});

/** EXIF の向きだけを持つ、最小の JPEG の先頭部分 */
function jpegWithOrientation(orientation: number, littleEndian: boolean): Uint8Array {
  const b: number[] = [0xff, 0xd8, 0xff, 0xe1];
  const tiff: number[] = [];
  const u16 = (v: number) => (littleEndian ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) => (littleEndian ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  tiff.push(...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0));
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  b.push((payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload, 0xff, 0xda, 0, 2);
  return Uint8Array.from(b);
}

describe('jpegOrientation', () => {
  it.each([1, 3, 6, 8])('EXIF の向き %i を読む(リトル・ビッグエンディアン)', (o) => {
    expect(jpegOrientation(jpegWithOrientation(o, true))).toBe(o);
    expect(jpegOrientation(jpegWithOrientation(o, false))).toBe(o);
  });

  it('EXIF がない・JPEG でないなら 1', () => {
    expect(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(jpegOrientation(makePng(2, 2, [0, 0, 0]))).toBe(1);
  });
});
