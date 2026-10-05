import { PDFDocument } from '@cantoo/pdf-lib';

/**
 * 幅の異なるページを持つ PDF を作る。ページの幅で「どの元ページか」を識別できるようにする。
 * 例: makePdf([101, 102, 103]) → 幅 101pt, 102pt, 103pt の 3 ページ
 */
export async function makePdf(widths: readonly number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 200]);
  return doc.save();
}

/** PDF のページの幅(回転前の MediaBox の幅)と回転角を読み出す */
export async function describePdf(bytes: Uint8Array): Promise<{ width: number; rotation: number }[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({ width: Math.round(p.getMediaBox().width), rotation: p.getRotation().angle }));
}
