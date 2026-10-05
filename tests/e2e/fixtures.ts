import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';
import type { Download, Page } from '@playwright/test';

/** 幅の異なるページを持ち、各ページに文字が描かれた PDF を作る(幅で元ページを識別する) */
export async function makePdf(label: string, widths: readonly number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  widths.forEach((w, i) => {
    const page = doc.addPage([w, 300]);
    page.drawText(`${label}${i + 1}`, { x: 10, y: 140, size: 36, font, color: rgb(0.1, 0.2, 0.5) });
  });
  return Buffer.from(await doc.save());
}

export async function encryptedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.encrypt({ userPassword: '', ownerPassword: 'owner-secret', permissions: { modifying: false } });
  return Buffer.from(await doc.save());
}

export async function addPdfs(page: Page, files: { name: string; buffer: Buffer }[]): Promise<void> {
  await page.setInputFiles(
    '#file-input',
    files.map((f) => ({ name: f.name, mimeType: 'application/pdf', buffer: f.buffer })),
  );
}

export async function downloadedBytes(download: Download): Promise<Uint8Array> {
  const path = await download.path();
  return new Uint8Array(await readFile(path));
}

export async function describePdf(bytes: Uint8Array): Promise<{ width: number; rotation: number }[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => ({ width: Math.round(p.getMediaBox().width), rotation: p.getRotation().angle }));
}
