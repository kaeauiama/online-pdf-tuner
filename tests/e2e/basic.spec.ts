import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { addPdfs, describePdf, downloadedBytes, encryptedPdf, makePdf } from './fixtures.ts';

const cards = '.page-card';
const card = (n: number) => `.page-card >> nth=${n - 1}`;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [
    { name: 'a.pdf', buffer: await makePdf('A', [101, 102, 103]) },
    { name: 'b.pdf', buffer: await makePdf('B', [201, 202]) },
  ]);
  await expect(page.locator(cards)).toHaveCount(5);
});

test('2 つの PDF を読み込み、サムネイルを表示する', async ({ page }) => {
  await expect(page.locator('#dropzone')).toBeHidden();
  await expect(page.locator('.file-chip')).toHaveCount(2);
  await expect(page.locator('.thumb canvas[data-state="done"]')).toHaveCount(5);
});

test('回転・並べ替え・削除して 1 つの PDF に保存する', async ({ page }) => {
  await page.click(card(1));
  await page.click('[data-action="rotate-right"]');
  await page.click(card(5));
  await page.click('[data-action="move-prev"]'); // A1 A2 A3 B2 B1
  await page.click(card(2));
  await page.keyboard.press('Delete'); // A1 A3 B2 B1
  await expect(page.locator(cards)).toHaveCount(4);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  expect(download.suggestedFilename()).toBe('a_結合.pdf');
  expect(await describePdf(await downloadedBytes(download))).toEqual([
    { width: 101, rotation: 90 },
    { width: 103, rotation: 0 },
    { width: 202, rotation: 0 },
    { width: 201, rotation: 0 },
  ]);

  await page.keyboard.press('Control+z');
  await expect(page.locator(cards)).toHaveCount(5);
});

test('Shift+クリックで範囲選択し、選択ページだけを保存する', async ({ page }) => {
  await page.click(card(2));
  await page.click(card(4), { modifiers: ['Shift'] });
  await expect(page.locator('#selection-count')).toHaveText('3 / 5 ページを選択中');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-selected"]')]);
  expect(await describePdf(await downloadedBytes(download))).toEqual([
    { width: 102, rotation: 0 },
    { width: 103, rotation: 0 },
    { width: 201, rotation: 0 },
  ]);
});

test('ドラッグで並べ替える', async ({ page }) => {
  await page.dragAndDrop(card(5), card(1), { targetPosition: { x: 5, y: 60 } });
  await expect(page.locator('.page-card .card-src').first()).toHaveText('b.pdf · p.2');
});

test('範囲を指定して分割し、ZIP で保存する', async ({ page }) => {
  await page.click('[data-action="open-split"]');
  await page.fill('input[name="ranges"]', '1-2, 3, 4-');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#split-form button[type="submit"]')]);
  expect(download.suggestedFilename()).toBe('a_分割.zip');
  const files = unzipSync(await downloadedBytes(download));
  expect(Object.keys(files).sort()).toEqual(['a_p1-2.pdf', 'a_p3.pdf', 'a_p4-5.pdf']);
  expect((await describePdf(files['a_p4-5.pdf'])).map((p) => p.width)).toEqual([201, 202]);
});

test('分割の範囲が不正ならダイアログ内にエラーを出す', async ({ page }) => {
  await page.click('[data-action="open-split"]');
  await page.fill('input[name="ranges"]', '1-9');
  await page.click('#split-form button[type="submit"]');
  await expect(page.locator('#split-error')).toContainText('存在しないページ番号');
  await expect(page.locator('#split-dialog')).toBeVisible();
});

test('HC-4: 編集制限付きの PDF は読み込まず、理由を表示する', async ({ page }) => {
  await addPdfs(page, [{ name: 'locked.pdf', buffer: await encryptedPdf() }]);
  await expect(page.locator('.toast-error')).toContainText('locked.pdf');
  await expect(page.locator('.toast-code')).toHaveText('UNSUPPORTED_ENCRYPTED_PDF');
  await expect(page.locator(cards)).toHaveCount(5);
});
