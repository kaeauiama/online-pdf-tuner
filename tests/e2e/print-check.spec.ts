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
    'PRINT_COLOR_DULL', // 模様の画像に鮮やかな色が含まれる
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

test('くすみ警告: 鮮やかな青の背景を指摘し、プレビューを「くすみやすい所」「印刷の目安」に切り替えられる', async ({ page }) => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([154 * MM, 216 * MM]);
  p.drawRectangle({ x: 0, y: 0, width: 154 * MM, height: 216 * MM, color: rgb(0, 0.2, 1) });
  await page.goto('/');
  await addPdfs(page, [{ name: 'blue.pdf', buffer: Buffer.from(await doc.save()) }]);
  await runCheck(page);

  const dull = page.locator('.finding').filter({ hasText: 'PRINT_COLOR_DULL' });
  await expect(dull.locator('.sev-badge')).toHaveText('注意');
  await expect(dull.locator('.finding-detail')).toContainText('約 100%');

  const centerPixel = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#preview-canvas')!;
      return [...c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3)];
    });
  const chroma = ([r, g, b]: number[]) => Math.max(r, g, b) - Math.min(r, g, b);

  // 結果の一覧が先に出て、プレビューはその後に描かれるので、描画を待つ
  await expect.poll(async () => (await centerPixel())[2]).toBeGreaterThan(200);
  const original = await centerPixel();

  await page.locator('.preview-modes').getByText('くすみやすい所').click();
  await expect(page.locator('#preview-mode-note')).toContainText('くすみやすい色');
  // くすみやすい色は元の色のまま残る
  await expect.poll(centerPixel).toEqual(original);

  await page.locator('.preview-modes').getByText('印刷の目安').click();
  await expect(page.locator('#preview-mode-note')).toContainText('おおよその色');
  await expect.poll(async () => chroma(await centerPixel())).toBeLessThan(chroma(original) - 30);

  await page.locator('.preview-modes').getByText('そのまま').click();
  await expect(page.locator('#preview-mode-note')).toBeHidden();
  await expect.poll(centerPixel).toEqual(original);
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
