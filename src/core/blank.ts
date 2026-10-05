import { PDFDocument } from '@cantoo/pdf-lib';

/** 白紙のページだけの PDF を作る(中綴じのページ数合わせなどに使う) */
export async function makeBlankPdf(count: number, widthPt: number, heightPt: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < count; i++) doc.addPage([widthPt, heightPt]);
  return doc.save();
}
