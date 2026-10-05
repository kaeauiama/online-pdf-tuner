import { PDFDocument, rgb, StandardFonts } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { makePng } from '../unit/png.ts';
import { addPdfs } from './fixtures.ts';

const MM = 72 / 25.4;

/** 問題を仕込んだ A5(塗り足しなし): 端まで色・端に近い文字・低解像度の画像・埋め込みなしフォント */
async function problemPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([148 * MM, 210 * MM]);
  page.drawRectangle({ x: 0, y: 0, width: 148 * MM, height: 60 * MM, color: rgb(0.1, 0.3, 0.7) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('EDGE', { x: 2 * MM, y: 120 * MM, size: 14, font, color: rgb(0, 0, 0) });
  const png = await doc.embedPng(makePng(40, 40, 'noise'));
  page.drawImage(png, { x: 40 * MM, y: 100 * MM, width: 50 * MM, height: 50 * MM });
  return Buffer.from(await doc.save());
}

/** 問題のない A5 + 塗り足し 3mm: 背景はページの端(塗り足し)まで、文字なし */
async function goodPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([154 * MM, 216 * MM]);
  page.drawRectangle({ x: 0, y: 0, width: 154 * MM, height: 216 * MM, color: rgb(0.95, 0.85, 0.6) });
  return Buffer.from(await doc.save());
}

async function runCheck(page: Page, profile = 'tcpc'): Promise<void> {
  await page.click('[data-mode-tab="check"]');
  await page.selectOption('#check-profile', profile);
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.check-summary')).toBeVisible();
}

const codes = (page: Page) => page.locator('.finding-code').allTextContents();

test('問題のある PDF: 塗り足し・文字の位置・解像度・フォントを指摘し、プレビューを表示する', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'problem.pdf', buffer: await problemPdf() }]);
  await runCheck(page);

  await expect(page.locator('.summary-layout')).toContainText('A5');
  await expect(page.locator('.summary-layout')).toContainText('仕上がりサイズ(塗り足しなし)');
  expect(await codes(page)).toEqual([
    'PRINT_NO_BLEED',
    'PRINT_FONT_NOT_EMBEDDED',
    'PRINT_TEXT_IN_UNSAFE_AREA',
    'PRINT_IMAGE_LOW_DPI',
    'PRINT_RGB_CONTENT',
  ]);
  // 端まで色があるのは下の帯だけ(左右の辺も下の部分だけ色がある)
  const noBleed = page.locator('.finding').filter({ hasText: 'PRINT_NO_BLEED' });
  await expect(noBleed.locator('.finding-detail')).toContainText('下');
  await expect(noBleed.locator('.finding-detail')).toContainText('154×216mm');
  await expect(page.locator('.finding').filter({ hasText: 'PRINT_TEXT_IN_UNSAFE_AREA' })).toContainText('「EDGE」');

  const canvas = page.locator('#preview-canvas');
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(100);
  await expect(page.locator('#preview-page')).toHaveText('1 / 1 ページ');
});

test('問題のない PDF: 要修正・注意なし。手動チェックリストと注意書きを表示する', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'good.pdf', buffer: await goodPdf() }]);
  await runCheck(page, 'accea');
  await expect(page.locator('.summary-layout')).toContainText('塗り足し 各辺 3.0mm');
  await expect(page.locator('.summary-ok')).toHaveText('大きな問題は見つかりませんでした。');
  expect(await codes(page)).toEqual(['PRINT_RGB_CONTENT']);
  await expect(page.locator('.manual-list')).toContainText('印刷内容');
  await expect(page.locator('.check-disclaimer')).toContainText('保証するものではありません');
});

test('中綴じを選ぶと、ページ数が 4 の倍数でないことを指摘する', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'good.pdf', buffer: await goodPdf() }]);
  await page.click('[data-mode-tab="check"]');
  await page.selectOption('select[name="binding"]', 'saddle');
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.finding').first()).toContainText('PRINT_PAGE_COUNT_SADDLE');
  await expect(page.locator('.finding').first()).toContainText('あと 3 ページ');
});

test('編集すると結果が古いことを示し、再チェック後も編集画面のサムネイルが正常に描ける', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'good.pdf', buffer: await goodPdf() }]);
  await runCheck(page);
  await page.click('[data-mode-tab="edit"]');
  await addPdfs(page, [{ name: 'problem.pdf', buffer: await problemPdf() }]);
  await expect(page.locator('.page-card')).toHaveCount(2);
  await page.click('[data-mode-tab="check"]');
  await expect(page.locator('.stale-banner')).toBeVisible();

  // 2 回目のチェック(前回の描画用文書を破棄してから作り直す)
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.stale-banner')).toHaveCount(0);
  await expect(page.locator('.summary-layout')).toContainText('2 ページ');
  expect(await codes(page)).toContain('PRINT_MIXED_SIZES'); // 154×216mm と 148×210mm

  // ページの番号ボタンでプレビューを切り替える
  await page.locator('.finding').filter({ hasText: 'PRINT_NO_BLEED' }).locator('.page-chip').first().click();
  await expect(page.locator('#preview-page')).toHaveText('2 / 2 ページ');

  // 編集画面に戻って、さらにファイルを追加してもサムネイルが描ける(共有ワーカーが壊れていない)
  await page.click('[data-mode-tab="edit"]');
  await addPdfs(page, [{ name: 'good2.pdf', buffer: await goodPdf() }]);
  await expect(page.locator('.thumb canvas[data-state="done"]')).toHaveCount(3);
});

test('入稿チェック画面では、Delete キーでページが消えない', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'good.pdf', buffer: await goodPdf() }]);
  await page.click('.page-card');
  await page.click('[data-mode-tab="check"]');
  await page.keyboard.press('Delete');
  await page.click('[data-mode-tab="edit"]');
  await expect(page.locator('.page-card')).toHaveCount(1);
});
