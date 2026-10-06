// M4: オフライン対応・マニフェスト・ファイルハンドラ
import { expect, test } from '@playwright/test';
import { addPdfs, makePdf } from './fixtures.ts';

test('一度開けば、オフラインでも開き直して PDF を扱える', async ({ page, context }) => {
  await page.goto('/');
  // Service Worker の準備(全ファイルの保存)が終わるまで待つ
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#dropzone')).toBeVisible();
  await addPdfs(page, [{ name: 'a.pdf', buffer: await makePdf('A', [101, 102]) }]);
  // pdf.js のワーカー・標準フォントも、保存したものから読める
  await expect(page.locator('.thumb canvas[data-state="done"]')).toHaveCount(2);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  expect(download.suggestedFilename()).toBe('a_編集済み.pdf');
  // 文字入れ用の日本語フォントも保存されている
  const fontCached = await page.evaluate(async () => {
    const res = await fetch('./fonts/BIZUDPGothic-Regular.subset.ttf');
    return res.ok && (await res.arrayBuffer()).byteLength > 1_000_000;
  });
  expect(fontCached).toBe(true);
  await context.setOffline(false);
});

test('マニフェストに、名前・アイコン・PDF のファイルハンドラがある', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(new URL(href!, page.url()).href)).json();
  expect(manifest.name).toBe('PDF 作業台');
  expect(manifest.start_url).toBe('./');
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.file_handlers[0].accept['application/pdf']).toEqual(['.pdf']);
  for (const icon of manifest.icons) {
    expect((await page.request.get(new URL(icon.src, page.url()).href)).ok()).toBe(true);
  }
});

test('「プログラムから開く」で渡された PDF を読み込む', async ({ page }) => {
  // Chromium のファイルハンドラ(launchQueue)を差し替えて、渡されたファイルを再現する
  // (Chrome の本物の launchQueue は読み取り専用なので、プロパティとして定義し直す)
  await page.addInitScript(() => {
    const w = window as unknown as { __launch?: (p: unknown) => void };
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer: (fn: (p: unknown) => void) => (w.__launch = fn) },
    });
  });
  await page.goto('/');
  const bytes = [...(await makePdf('L', [120, 130, 140]))];
  await page.evaluate((data) => {
    const file = new File([new Uint8Array(data)], 'opened.pdf', { type: 'application/pdf' });
    (window as unknown as { __launch: (p: unknown) => void }).__launch({ files: [{ getFile: async () => file }] });
  }, bytes);
  await expect(page.locator('.page-card')).toHaveCount(3);
  await expect(page.locator('.file-chip')).toContainText('opened.pdf');
});
