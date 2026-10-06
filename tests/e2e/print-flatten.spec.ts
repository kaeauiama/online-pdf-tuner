// 効果の焼き込み: 透明効果のあるページを、画像(下)+ 文字(上)にして入稿用 PDF を作る
import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';
import { expect, test } from '@playwright/test';
import { lexContent } from '../../src/pdf/lexer.ts';
import { pageContentBytes, scanStructure } from '../../src/print/structure.ts';
import { addPdfs, downloadedBytes } from './fixtures.ts';

const MM = 72 / 25.4;

async function transparentA5(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([154 * MM, 216 * MM]);
  page.drawRectangle({ x: 0, y: 0, width: 154 * MM, height: 216 * MM, color: rgb(0.95, 0.9, 0.7) });
  page.drawRectangle({ x: 30 * MM, y: 60 * MM, width: 90 * MM, height: 90 * MM, color: rgb(0.1, 0.3, 0.8), opacity: 0.4 });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Open House', { x: 40 * MM, y: 100 * MM, size: 28, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save());
}

test('透明効果を焼き込むと、透明効果がなくなり、文字は文字のまま残る', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'event.pdf', buffer: await transparentA5() }]);
  await page.click('[data-mode-tab="check"]');
  await page.click('#check-form button[type="submit"]');
  const transparency = page.locator('.finding').filter({ hasText: 'PRINT_TRANSPARENCY' });
  await expect(transparency).toBeVisible();

  // 指摘のボタンから、焼き込みの選択肢をオンにする
  await transparency.locator('.finding-action').click();
  await expect(page.locator('#flatten-fieldset input[name="flatten"]')).toBeChecked();
  await expect(page.locator('#flatten-fieldset input[name="flattenPages"][value="transparent"]')).toBeChecked();
  await page.click('#fix-panel button[type="submit"]');

  await expect(page.locator('.fixed-notes')).toContainText('350ppi の画像にし、文字は文字のまま');
  const codes = await page.locator('.finding-code').allTextContents();
  expect(codes).not.toContain('PRINT_TRANSPARENCY');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.fixed-actions .btn-primary')]);
  const out = await PDFDocument.load(await downloadedBytes(download));
  const [s] = scanStructure(out);
  expect(s.transparency).toBe(false);
  // 背景の画像が 1 枚(仕上がり以上の大きさ)、文字は Helvetica のまま
  const big = s.images.filter((im) => im.pixelWidth > 1000);
  expect(big).toHaveLength(1);
  expect(Math.round(big[0].dpi)).toBeGreaterThanOrEqual(349);
  expect(s.fonts.map((f) => f.name)).toContain('Helvetica');
  // 入稿用 PDF のページはフォームとして埋め込まれているので、フォームの中まで見て文字の命令を数える
  const ops = lexContent(pageContentBytes(out, out.getPage(0)));
  expect(ops.some((o) => o.op === 'Do')).toBe(true);
});
