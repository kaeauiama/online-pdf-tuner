// M6: ページの中(レイヤー表示・移動・削除)
import { readFileSync } from 'node:fs';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { extractElements } from '../../src/editor/elements.ts';
import { makePng } from '../unit/png.ts';
import { addPdfs, downloadedBytes } from './fixtures.ts';

const MM = 72 / 25.4;

/** 影(半透明の画像)+ 本体の画像 + 検索用の見えない文字 + 右上の小さな図形 */
async function fixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 600]);
  const img = await doc.embedPng(makePng(100, 50, 'noise'));
  page.node.setXObject(PDFName.of('Im1'), img.ref);
  const font = await doc.embedFont(readFileSync('public/fonts/BIZUDPGothic-Regular.subset.ttf'), { subset: true });
  const code = font.encodeText('見出し').toString(); // <...> の 16 進文字列
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.setExtGState(PDFName.of('Half'), doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: 0.4 })));
  page.node.setExtGState(PDFName.of('Clear'), doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: 0, CA: 0 })));
  const content = `q /Half gs 205 0 0 105 53 297 cm /Im1 Do Q
q 200 0 0 100 50 300 cm /Im1 Do Q
q BT /F1 30 Tf 2 Tr /Clear gs 1 0 0 1 60 330 Tm ${code} Tj ET Q
q 1 0 0 rg 330 530 40 40 re f Q`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  return Buffer.from(await doc.save());
}

async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await addPdfs(page, [{ name: 'layout.pdf', buffer: await fixture() }]);
  await page.click('[data-mode-tab="editor"]');
  await expect(page.locator('.layer-row').first()).toBeVisible();
}

async function savedElements(page: Page) {
  await page.click('[data-mode-tab="edit"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  const doc = await PDFDocument.load(await downloadedBytes(download));
  return extractElements(doc, doc.getPage(0));
}

const rowByName = (page: Page, name: string) => page.locator('.layer-row').filter({ hasText: name });

test('レイヤー: 上が手前の順で並び、影は本体の下に「効果(推定)」としてまとまる', async ({ page }) => {
  await openEditor(page);
  const names = await page.locator('.layer-row .layer-name').allTextContents();
  expect(names).toEqual(['図形', '文字の画像「見出し」', '画像(100×50px)']);
  await expect(page.locator('.layer-row.is-nested .layer-chip.is-effect')).toHaveText('効果(推定)');
  // 見えない文字は、表示を切り替えると画像の下に出る
  await page.check('#editor-show-hidden');
  await expect(rowByName(page, '検索用の見えない文字「見出し」')).toBeVisible();
});

test('画像を矢印キーで動かして適用すると、影と見えない文字も一緒に動く。編集画面で元に戻せる', async ({ page }) => {
  await openEditor(page);
  await rowByName(page, '文字の画像「見出し」').click();
  await expect(page.locator('#editor-props .props-info')).toContainText('検索用の見えない文字: 1 個');
  await page.locator('#editor-stage').focus();
  await page.keyboard.press('Shift+ArrowRight'); // 5mm 右へ
  await page.keyboard.press('Shift+ArrowUp'); // 5mm 上へ
  await expect(page.locator('#editor-status')).toHaveText('適用していない変更: 3 個の要素');
  await page.click('#editor-apply');
  await expect(page.locator('.toast').last()).toContainText('ページに反映しました');

  const after = await savedElements(page);
  const [shadow, main, text] = after;
  expect(main.bounds.x0).toBeCloseTo(50 + 5 * MM, 1);
  expect(main.bounds.y0).toBeCloseTo(300 + 5 * MM, 1);
  expect(shadow.bounds.x0).toBeCloseTo(53 + 5 * MM, 1);
  expect(text.overlayOf).toBe(main.id);
  expect(shadow.effectOf).toBe(main.id);

  await page.keyboard.press('Control+z');
  const undone = await savedElements(page);
  expect(undone[1].bounds.x0).toBeCloseTo(50, 1);
});

test('削除・一時的に隠す・タブ内の元に戻す', async ({ page }) => {
  await openEditor(page);
  // 一時的に隠しても、保存には影響しない
  await rowByName(page, '図形').locator('.layer-eye').click();
  await rowByName(page, '図形').click();
  await page.click('#editor-props .btn-danger');
  await expect(rowByName(page, '図形').locator('.layer-chip.is-deleted')).toBeVisible();
  // タブ内で元に戻して、もう一度削除する
  await page.click('#editor-undo');
  await expect(rowByName(page, '図形').locator('.layer-chip.is-deleted')).toHaveCount(0);
  await page.click('#editor-redo');
  await page.click('#editor-apply');
  const after = await savedElements(page);
  expect(after.map((e) => e.kind)).toEqual(['image', 'image', 'text']);
});

test('適用していない変更があるときは、タブを離れる前に確かめる', async ({ page }) => {
  await openEditor(page);
  await rowByName(page, '図形').click();
  await page.click('#editor-props .btn-danger');
  page.once('dialog', (d) => void d.dismiss());
  await page.click('[data-mode-tab="edit"]');
  await expect(page.locator('#editor-view')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.click('[data-mode-tab="edit"]');
  await expect(page.locator('#edit-view')).toBeVisible();
  // 破棄したので、保存した PDF には図形が残っている
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  const doc = await PDFDocument.load(await downloadedBytes(download));
  expect(extractElements(doc, doc.getPage(0)).map((e) => e.kind)).toContain('path');
});
