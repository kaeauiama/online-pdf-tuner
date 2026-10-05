// 手動確認用のサンプル PDF を作る。使い方: node scripts/make-sample-pdfs.mjs <出力先ディレクトリ>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';

const A4 = [595.28, 841.89];

async function make(title, pageCount, color, landscapeAt = -1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pageCount; i++) {
    const [w, h] = i === landscapeAt ? [A4[1], A4[0]] : A4;
    const page = doc.addPage([w, h]);
    page.drawRectangle({ x: 0, y: h - 160, width: w, height: 160, color });
    page.drawText(title, { x: 40, y: h - 100, size: 44, font, color: rgb(1, 1, 1) });
    page.drawText(`Page ${i + 1}`, { x: 40, y: h / 2, size: 72, font, color: rgb(0.2, 0.2, 0.25) });
    for (let k = 0; k < 6; k++) {
      page.drawRectangle({ x: 40, y: 200 - k * 24, width: w - 80 - k * 40, height: 10, color: rgb(0.8, 0.82, 0.86) });
    }
  }
  return doc.save();
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/make-sample-pdfs.mjs <outDir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'newsletter.pdf'), await make('Newsletter', 4, rgb(0.12, 0.37, 0.75), 2));
writeFileSync(join(outDir, 'flyer.pdf'), await make('Flyer', 2, rgb(0.85, 0.5, 0.17)));
console.log(`samples written to ${outDir}`);
