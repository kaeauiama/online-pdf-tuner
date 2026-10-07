// 大きな PDF での移動: ヘッダーの固定、ダブルクリックで「編集」、ページへ移動、サムネイルの大きさ
import { expect, test } from '@playwright/test';
import { addPdfs, makePdf } from './fixtures.ts';

const MANY = Array.from({ length: 60 }, () => 200);

test('ヘッダーは固定され、下までスクロールしても画面を切り替えられる', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'many.pdf', buffer: await makePdf('P', MANY) }]);
  await expect(page.locator('.page-card')).toHaveCount(60);
  await page.locator('.page-card').last().scrollIntoViewIfNeeded();
  const header = await page.locator('.app-header').boundingBox();
  expect(header!.y).toBeLessThanOrEqual(1);
  // ツールバーはヘッダーのすぐ下に付いてくる
  const toolbar = await page.locator('#edit-view .toolbar').boundingBox();
  expect(toolbar!.y).toBeCloseTo(header!.height, 0);
  await page.click('[data-mode-tab="check"]');
  await expect(page.locator('#check-view')).toBeVisible();
  await page.click('[data-mode-tab="edit"]');
  await expect(page.locator('#edit-view')).toBeVisible();
});

test('ページをダブルクリック(またはボタン・Enter)で「編集」を開き、戻るとそのページを示す', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'many.pdf', buffer: await makePdf('P', MANY) }]);
  await page.locator('.page-card').nth(11).dblclick();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect(page.locator('#editor-page')).toHaveValue('11');

  // 戻ると、開いていたページが選ばれて見えている
  await page.click('[data-mode-tab="edit"]');
  const card = page.locator('.page-card').nth(11);
  await expect(card).toHaveClass(/is-selected/);
  await expect(card).toBeInViewport();

  // 選んだ 1 ページは Enter でも開ける
  await page.locator('.page-card').nth(20).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('#editor-page')).toHaveValue('20');

  // カードのボタンでも開ける
  await page.click('[data-mode-tab="edit"]');
  await page.locator('.page-card').nth(3).hover();
  await page.locator('.page-card').nth(3).locator('.card-open').click();
  await expect(page.locator('#editor-page')).toHaveValue('3');
});

test('ページへ移動と、サムネイルの大きさ(小)。大きさは再読み込みしても覚えている', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'many.pdf', buffer: await makePdf('P', MANY) }]);
  await expect(page.locator('#page-total')).toHaveText('/ 60');
  await page.fill('#page-jump', '45');
  await page.press('#page-jump', 'Enter');
  const card = page.locator('.page-card').nth(44);
  await expect(card).toHaveClass(/is-selected/);
  await expect(card).toBeInViewport();

  const before = (await page.locator('.page-card').first().boundingBox())!.width;
  await page.locator('.view-size label').filter({ hasText: '小' }).click();
  await expect(page.locator('#grid')).toHaveAttribute('data-size', 'small');
  const after = (await page.locator('.page-card').first().boundingBox())!.width;
  expect(after).toBeLessThan(before * 0.8);
  await page.reload();
  await expect(page.locator('#grid')).toHaveAttribute('data-size', 'small');
});
