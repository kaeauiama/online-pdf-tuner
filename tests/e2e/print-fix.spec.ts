import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { addPdfs, downloadedBytes } from './fixtures.ts';

const MM = 72 / 25.4;

/** 塗り足しなしの A5。背景が端まである(フチなしにしたいのに塗り足しがない状態) */
async function fullBleedA5(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([148 * MM, 210 * MM]);
  page.drawRectangle({ x: 0, y: 0, width: 148 * MM, height: 210 * MM, color: rgb(0.85, 0.55, 0.2) });
  page.drawRectangle({ x: 30 * MM, y: 80 * MM, width: 88 * MM, height: 50 * MM, color: rgb(0.2, 0.3, 0.6) });
  return Buffer.from(await doc.save());
}

/** 余白(白いフチ)15mm 付きで作ってしまった A5 の表紙 */
async function framedCover(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([148 * MM, 210 * MM]);
  page.drawRectangle({ x: 15 * MM, y: 15 * MM, width: 118 * MM, height: 180 * MM, color: rgb(0.3, 0.6, 0.4) });
  return Buffer.from(await doc.save());
}

async function check(page: Page, binding: 'none' | 'saddle' = 'none'): Promise<void> {
  await page.click('[data-mode-tab="check"]');
  await page.selectOption('#check-profile', 'tcpc');
  await page.selectOption('select[name="binding"]', binding);
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.check-summary')).toBeVisible();
}

const codes = (page: Page) => page.locator('.finding-code').allTextContents();

async function savePrintReady(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.fixed-actions .btn-primary')]);
  return { name: download.suggestedFilename(), doc: await PDFDocument.load(await downloadedBytes(download)) };
}

const sizeMm = (box: { width: number; height: number }) => [Math.round(box.width / MM), Math.round(box.height / MM)];

test('塗り足しがない PDF に、鏡写しで塗り足しを作り、再チェックで問題が消える', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await fullBleedA5() }]);
  await check(page);
  expect(await codes(page)).toContain('PRINT_NO_BLEED');

  // 指摘のボタンから「入稿用 PDF を作る」へ
  await page.locator('.finding-action').first().click();
  await expect(page.locator('#fix-panel input[name="method"][value="mirror"]')).toBeChecked();
  await page.click('#fix-panel button[type="submit"]');

  await expect(page.locator('.fixed-banner')).toBeVisible();
  await expect(page.locator('.fixed-notes')).toContainText('鏡写し');
  await expect(page.locator('.summary-layout')).toContainText('TrimBox');
  await expect(page.locator('.summary-layout')).toContainText('塗り足し 各辺 3.0mm');
  const after = await codes(page);
  expect(after).not.toContain('PRINT_NO_BLEED');
  expect(after).not.toContain('PRINT_WHITE_EDGE');
  await expect(page.locator('#preview-page')).toContainText('入稿用 PDF');

  const { name, doc } = await savePrintReady(page);
  expect(name).toBe('flyer_入稿用.pdf');
  const p = doc.getPage(0);
  expect(sizeMm(p.getMediaBox())).toEqual([154, 216]);
  expect(sizeMm(p.getTrimBox())).toEqual([148, 210]);
  expect(Math.round(p.getTrimBox().x / MM)).toBe(3);

  // 元の結果に戻れる
  await page.click('text=元の PDF の結果に戻る');
  await expect(page.locator('.fixed-banner')).toHaveCount(0);
  expect(await codes(page)).toContain('PRINT_NO_BLEED');
});

test('トンボ付きで作ると、ページが大きくなり、再チェックでも塗り足しが正しく判定される', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await fullBleedA5() }]);
  await check(page);
  await page.check('#fix-panel input[name="output"][value="marks"]');
  await page.click('#fix-panel button[type="submit"]');
  await expect(page.locator('.fixed-banner')).toBeVisible();
  const after = await codes(page);
  expect(after).not.toContain('PRINT_NO_BLEED');
  expect(after).not.toContain('PRINT_WHITE_EDGE');
  const { doc } = await savePrintReady(page);
  expect(sizeMm(doc.getPage(0).getMediaBox())).toEqual([148 + 32, 210 + 32]);
  expect(sizeMm(doc.getPage(0).getBleedBox())).toEqual([154, 216]);
});

test('白いフチ付きの表紙を、フチを取り除いて塗り足しまで引き伸ばす', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'cover.pdf', buffer: await framedCover() }]);
  await check(page);
  // 端は白いので、塗り足しの指摘はない(既定は「塗り足しを付けない」)
  expect(await codes(page)).not.toContain('PRINT_NO_BLEED');
  await expect(page.locator('#fix-panel input[name="method"][value="none"]')).toBeChecked();

  await page.check('#fix-panel input[name="method"][value="region"]');
  await expect(page.locator('#fix-panel input[name="fit"][value="cover"]')).toBeVisible();
  await page.click('#fix-panel button[type="submit"]');
  await expect(page.locator('.fixed-notes')).toContainText('白いフチを取り除き');

  // プレビューの左上(塗り足しの角)まで色が付いている
  const corner = async () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#preview-canvas')!;
      const d = c.getContext('2d')!.getImageData(3, 3, 1, 1).data;
      return Math.min(d[0], d[1], d[2]);
    });
  await expect.poll(corner).toBeLessThan(200);
  expect(await codes(page)).not.toContain('PRINT_WHITE_EDGE');
});

test('中綴じのページ数が足りないとき、白紙を足してから再チェックする', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await fullBleedA5() }]);
  await check(page, 'saddle');
  const action = page.locator('.finding').filter({ hasText: 'PRINT_PAGE_COUNT_SADDLE' }).locator('.finding-action');
  await expect(action).toHaveText('白紙を 3 ページ足す(最後のページの前に)');
  await action.click();
  await expect(page.locator('.summary-layout')).toContainText('4 ページ');
  expect(await codes(page)).not.toContain('PRINT_PAGE_COUNT_SADDLE');
  await page.click('[data-mode-tab="edit"]');
  await expect(page.locator('.page-card')).toHaveCount(4);
  await expect(page.locator('.page-card .card-src').last()).toHaveText('flyer.pdf · p.1');
});
