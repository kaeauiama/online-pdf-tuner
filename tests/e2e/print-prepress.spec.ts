// 入稿の最終調整(D-033〜D-035): 指摘の場所のフォーカス表示、追加のチェック、文字のアウトライン化、色の調整
import { readFileSync } from 'node:fs';
import fontkit from '@cantoo/fontkit';
import { PDFDict, PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { lexContent } from '../../src/pdf/lexer.ts';
import { scanStructure, streamBytes } from '../../src/print/structure.ts';
import { addPdfs, downloadedBytes } from './fixtures.ts';

const W = 419.53;
const H = 595.28; // A5

/** 細い線・白のオーバープリント・リッチブラックの小さな文字・RGB の色を含む A5 のチラシ */
async function prepressPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(readFileSync('public/fonts/BIZUDPGothic-Regular.subset.ttf'), { subset: true });
  page.node.setFontDictionary(PDFName.of('F1'), font.ref);
  page.node.setExtGState(PDFName.of('OP'), doc.context.register(doc.context.obj({ Type: 'ExtGState', OP: true, op: true })));
  const t = (s: string) => font.encodeText(s).toString();
  const content = `BT /F1 24 Tf 0 0 0 rg 40 520 Td ${t('空手道教室のご案内')} Tj ET
BT /F1 9 Tf 0.5 0.4 0.4 1 k 40 480 Td ${t('説明文')} Tj ET
q 0.1 w 0 0 0 RG 40 440 m 380 440 l S Q
q 0 w 0 0 0 RG 40 420 m 380 420 l S Q
q 0.2 0.5 0.9 rg 200 250 150 120 re f Q
q /OP gs 1 1 1 rg 220 280 60 20 re f Q`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  return Buffer.from(await doc.save());
}

async function check(page: Page): Promise<void> {
  await page.click('[data-mode-tab="check"]');
  await page.click('#check-form button[type="submit"]');
  await expect(page.locator('.check-summary')).toBeVisible();
}

const codes = (page: Page) => page.locator('.finding-code').allTextContents();

async function saveFixed(page: Page): Promise<PDFDocument> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.fixed-actions .btn-primary')]);
  return PDFDocument.load(await downloadedBytes(download));
}

/** 入稿用 PDF の中身(埋め込んだ元のページのフォーム)を取り出す */
function embeddedPage(doc: PDFDocument): { content: Uint8Array } {
  const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects.entries()) {
    const x = doc.context.lookup(ref);
    if (x instanceof PDFStream && x.dict.get(PDFName.of('Subtype'))?.toString() === '/Form') return { content: streamBytes(x) };
  }
  throw new Error('no embedded page');
}

test('追加のチェック: 線幅 0・細い線・白のオーバープリント・リッチブラックの文字を指摘する', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await prepressPdf() }]);
  await check(page);
  expect(await codes(page)).toEqual(
    expect.arrayContaining(['PRINT_LINE_ZERO_WIDTH', 'PRINT_LINE_TOO_THIN', 'PRINT_WHITE_OVERPRINT', 'PRINT_RICH_BLACK_TEXT', 'PRINT_RGB_CONTENT']),
  );
});

test('指摘の場所を見る: 対象を強調し、小さければ拡大する。前後の場所へ移れる。プレビューの枠を押して指摘を選べる', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await prepressPdf() }]);
  await check(page);
  const thin = page.locator('.finding').filter({ hasText: '細すぎる線' });
  await thin.getByRole('button', { name: /場所を見る/ }).click();
  await expect(page.locator('#preview-focus')).toBeVisible();
  await expect(page.locator('#focus-label')).toContainText('線幅 約 0.04mm');
  await expect(page.locator('#focus-zoom')).toHaveAttribute('aria-pressed', 'true');
  await expect(thin.locator('.focus-count')).toHaveText('1 / 1');
  // 全体表示に切り替えられる
  await page.click('#focus-zoom');
  await expect(page.locator('#focus-zoom')).toHaveAttribute('aria-pressed', 'false');
  // 選択を解除すると、操作の帯が消える
  await page.click('#focus-clear');
  await expect(page.locator('#preview-focus')).toBeHidden();

  // プレビューの枠(白のオーバープリントの場所)を押すと、その指摘が選ばれる
  const canvas = page.locator('#preview-canvas');
  const box = (await canvas.boundingBox())!;
  const s = box.width / W;
  await canvas.click({ position: { x: 250 * s, y: (H - 290) * s } });
  await expect(page.locator('.finding.is-focused .finding-title')).toContainText('オーバープリント');
});

test('入稿用 PDF: CMYK に変換し、白のオーバープリントを解除し、文字をアウトライン化する', async ({ page }) => {
  await page.goto('/');
  await addPdfs(page, [{ name: 'flyer.pdf', buffer: await prepressPdf() }]);
  await check(page);
  // 指摘のボタンから、色の設定へ
  await page.locator('.finding').filter({ hasText: 'RGB の色' }).locator('.finding-action').click();
  await expect(page.locator('input[name="color"][value="cmyk"]')).toBeChecked();
  await expect(page.locator('input[name="fixWhiteOverprint"]')).toBeChecked();
  await page.check('input[name="outline"]');
  await page.click('#fix-panel button[type="submit"]');
  await expect(page.locator('.fixed-banner')).toBeVisible();
  const notes = page.locator('.fixed-notes');
  await expect(notes).toContainText('CMYK(Japan Color 2011 Coated)に変換しました');
  await expect(notes).toContainText('リッチブラックの小さな文字 1 か所を K100 にしました');
  await expect(notes).toContainText('白のオーバープリント 1 か所を解除しました');
  await expect(notes).toContainText('文字をアウトライン化しました');
  // 再チェック: RGB・白のオーバープリントの指摘が消え、フォントもなくなる
  const after = await codes(page);
  expect(after).not.toContain('PRINT_RGB_CONTENT');
  expect(after).not.toContain('PRINT_WHITE_OVERPRINT');
  await expect(page.locator('.font-list')).toHaveCount(0);

  const doc = await saveFixed(page);
  const structure = scanStructure(doc)[0];
  expect(structure.colorUse.rgb).toBe(0);
  expect(structure.fonts).toHaveLength(0);
  const { content } = embeddedPage(doc);
  const ops = lexContent(content);
  expect(ops.filter((o) => ['Tj', 'TJ'].includes(o.op))).toHaveLength(0);
  expect(ops.some((o) => o.op === 'rg' || o.op === 'RG')).toBe(false);
});

test('CMYK 変換: JPEG の写真も CMYK の画像にする。変換できない部分があるページは焼き込んでから変換する', async ({ page }) => {
  await page.goto('/');
  // ブラウザで JPEG を作る(グラデーションの写真の代わり)
  const jpegBase64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, '#e03030');
    g.addColorStop(1, '#2050e0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 32);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([W, H]);
  const jpg = await doc.embedJpg(Buffer.from(jpegBase64, 'base64'));
  p1.drawImage(jpg, { x: 40, y: 300, width: 300, height: 150 });
  // 2 ページ目: インライン画像(そのままでは変換できない)
  const p2 = doc.addPage([W, H]);
  p2.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream(Uint8Array.from([...'q 100 0 0 100 50 50 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID '].map((ch) => ch.charCodeAt(0)).concat([255, 0, 0, 0, 0, 255], [...' EI Q'].map((ch) => ch.charCodeAt(0)))))),
  );
  await addPdfs(page, [{ name: 'photo.pdf', buffer: Buffer.from(await doc.save()) }]);
  await check(page);
  await page.check('input[name="color"][value="cmyk"]');
  await page.click('#fix-panel button[type="submit"]');
  await expect(page.locator('.fixed-banner')).toBeVisible();
  await expect(page.locator('.fixed-notes li').nth(0)).toContainText('画像 1 個');
  await expect(page.locator('.fixed-notes li').nth(1)).toContainText('文字以外を画像にしてから変換しました');
  const out = await saveFixed(page);
  const pages = scanStructure(out);
  for (const s of pages) {
    expect(s.colorUse.rgb).toBe(0);
    expect(s.images.every((img) => img.color !== 'rgb')).toBe(true);
  }
});
