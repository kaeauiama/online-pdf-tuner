import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { textRuns } from '../../src/typo/typo.ts';
import { typoPdf } from '../unit/typoFixture.ts';
import { addPdfs, downloadedBytes } from './fixtures.ts';

async function savedText(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  const doc = await PDFDocument.load(await downloadedBytes(download));
  return textRuns(doc, doc.getPage(0))
    .runs.flatMap((r) => r.glyphs.map((g) => g.text))
    .join('');
}

async function search(page: Page, find: string, replace: string): Promise<void> {
  await page.click('[data-action="open-typo"]');
  await page.fill('#typo-form input[name="find"]', find);
  await page.fill('#typo-form input[name="replace"]', replace);
  await page.click('#typo-form button[type="submit"]');
}

test('同じフォント内の字で置き換え、保存した PDF の文字が変わる。元に戻せる', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'notice.pdf', buffer: Buffer.from(await typoPdf(0x0008)) }]);
  await search(page, '回', '会');
  await expect(page.locator('.typo-summary')).toHaveText('1 箇所見つかりました。そのうち 1 箇所を置き換えられます。');
  await expect(page.locator('.typo-item.is-ok')).toContainText('1 ページ目');
  await page.click('#typo-apply');
  await expect(page.locator('.toast')).toContainText('1 箇所を「会」に置き換えました');
  expect(await savedText(page)).toBe('講習会');

  await page.keyboard.press('Control+z');
  expect(await savedText(page)).toBe('講習回');
});

test('編集を許可していないフォントは、理由を示して置き換えない', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'notice.pdf', buffer: Buffer.from(await typoPdf(0x0004)) }]);
  await search(page, '回', '会');
  await expect(page.locator('.typo-item.is-ng .typo-reason')).toContainText('プレビューと印刷のみ');
  await expect(page.locator('#typo-apply')).toBeDisabled();
});

test('PC のフォントで補う: 足りない字を PC の同じフォントから補って置き換える', async ({ page }) => {
  // Local Font Access API を差し替え、同梱のフォントを「PC に入っているフォント」として返す
  await page.addInitScript(() => {
    (window as unknown as { queryLocalFonts: () => Promise<unknown[]> }).queryLocalFonts = async () => [
      {
        postscriptName: 'BIZUDPGothic-Regular',
        fullName: 'BIZ UDPGothic',
        blob: async () => (await fetch('./fonts/BIZUDPGothic-Regular.subset.ttf')).blob(),
      },
    ];
  });
  // 「講習回」だけを埋め込んだ PDF(「会」の字はない)
  const fontkit = (await import('@cantoo/fontkit')).default;
  const { readFileSync } = await import('node:fs');
  const src = await PDFDocument.create();
  src.registerFontkit(fontkit);
  const font = await src.embedFont(readFileSync('public/fonts/BIZUDPGothic-Regular.subset.ttf'), { subset: true });
  src.addPage([300, 200]).drawText('講習回', { x: 20, y: 100, size: 24, font });

  await page.goto('/');
  await addPdfs(page, [{ name: 'notice.pdf', buffer: Buffer.from(await src.save()) }]);
  await search(page, '回', '会');
  await expect(page.locator('.typo-item.is-ng')).toHaveCount(1);
  await page.click('.typo-pc-fonts button');
  await expect(page.locator('.typo-item.is-ok .typo-local-tag')).toHaveText('PC のフォントで補う');
  await page.click('#typo-apply');
  await expect(page.locator('.toast')).toContainText('1 箇所を「会」に置き換えました');
  expect(await savedText(page)).toBe('講習会');
});

test('フォントにない字・字数の違いは、理由を示す', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'notice.pdf', buffer: Buffer.from(await typoPdf(0x0008)) }]);
  await search(page, '回', '演');
  await expect(page.locator('.typo-item.is-ng .typo-reason')).toContainText('「演」は、この PDF に埋め込まれた「TestMincho」に含まれていません');
  await page.fill('#typo-form input[name="replace"]', '会議');
  await page.click('#typo-form button[type="submit"]');
  await expect(page.locator('#typo-error')).toContainText('字数が違います');
});
