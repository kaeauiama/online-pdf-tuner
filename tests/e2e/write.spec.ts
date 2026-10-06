// M5: ページ番号・文字入れ・画像 ⇔ PDF
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { textRuns } from '../../src/typo/typo.ts';
import { makePng } from '../unit/png.ts';
import { addPdfs, downloadedBytes } from './fixtures.ts';

const MM = 72 / 25.4;

async function a5(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([148 * MM, 210 * MM]);
    p.drawRectangle({ x: 20, y: 20, width: 100, height: 100, color: rgb(0.9, 0.9, 0.95) });
  }
  return Buffer.from(await doc.save());
}

async function saveAll(page: Page): Promise<PDFDocument> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  return PDFDocument.load(await downloadedBytes(download));
}

const pageTexts = (doc: PDFDocument) =>
  doc.getPages().map((_, i) =>
    textRuns(doc, doc.getPage(i))
      .runs.flatMap((r) => r.glyphs.map((g) => g.text))
      .join(''),
  );

test('ページ番号: 表紙を飛ばして「1 / 2」形式で入れ、見本を表示する。元に戻せる', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'booklet.pdf', buffer: await a5(3) }]);
  await page.click('[data-action="open-numbers"]');
  await page.fill('#number-form input[name="skip"]', '1');
  await page.selectOption('#number-form select[name="format"]', 'slash');
  // 見本が描かれる
  await expect.poll(() => page.locator('#number-dialog canvas.write-preview').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(50);
  await page.click('#number-form button[type="submit"]');
  await expect(page.locator('.toast')).toContainText('2 ページにページ番号を入れました');
  expect(pageTexts(await saveAll(page))).toEqual(['', '1 / 2', '2 / 2']);

  await page.keyboard.press('Control+z');
  expect(pageTexts(await saveAll(page))).toEqual(['', '', '']);
});

test('文字入れ: 選択中のページだけに入れる。フォントにない字は理由を示す', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await a5(2) }]);
  await page.click('.page-card >> nth=1');
  await page.click('[data-action="open-text"]');
  await page.fill('#text-form textarea[name="text"]', '社外秘 {page}/{total}');
  await page.check('#text-form input[name="target"][value="selected"]');
  await page.click('#text-form button[type="submit"]');
  await expect(page.locator('.toast')).toContainText('1 ページに文字を入れました');
  expect(pageTexts(await saveAll(page))).toEqual(['', '社外秘 2/2']);

  await page.click('[data-action="open-text"]');
  await page.fill('#text-form textarea[name="text"]', '𠮷');
  await page.click('#text-form button[type="submit"]');
  await expect(page.locator('#text-dialog .form-error')).toContainText('「𠮷」は、同梱のフォント');
});

test('画像を読み込むと、設定を聞いてから PDF のページにする', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file-input', [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(600, 400, 'noise')) }]);
  await expect(page.locator('#image-import-dialog')).toBeVisible();
  await expect(page.locator('#image-import-lead')).toContainText('1 枚の画像');
  await page.click('#image-import-form button[type="submit"]');
  await expect(page.locator('.page-card')).toHaveCount(1);
  await expect(page.locator('.file-chip')).toContainText('photo.pdf');
  const doc = await saveAll(page);
  const p = doc.getPage(0);
  expect([Math.round(p.getWidth() / MM), Math.round(p.getHeight() / MM)]).toEqual([297, 210]);
});

test('ページを画像で保存する(複数は ZIP)', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await a5(2) }]);
  await page.click('[data-action="open-export-images"]');
  await page.check('#image-export-form input[name="dpi"][value="150"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#image-export-form button[type="submit"]')]);
  expect(download.suggestedFilename()).toBe('flyer_画像.zip');
  const files = unzipSync(await downloadedBytes(download));
  expect(Object.keys(files).sort()).toEqual(['flyer_p1.png', 'flyer_p2.png']);
  const png = files['flyer_p1.png'];
  expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  // 150ppi の A5 ≒ 874 × 1240 画素
  const width = new DataView(png.buffer, png.byteOffset).getUint32(16);
  expect(Math.abs(width - Math.round((148 / 25.4) * 150))).toBeLessThanOrEqual(2);
});
