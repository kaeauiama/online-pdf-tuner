// HC-4: パスワードを知らない暗号化 PDF の解除・権限制限の回避をしない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { loadPdfForEdit } from '../../src/core/pdfLoad.ts';

async function encryptedPdf(userPassword: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  doc.encrypt({ userPassword, ownerPassword: 'owner-secret', permissions: { modifying: false, copying: false } });
  return doc.save();
}

describe('HC-4: 暗号化 PDF の拒否', () => {
  it('閲覧パスワード付きの PDF を拒否する', async () => {
    const result = await loadPdfForEdit(await encryptedPdf('user-secret'));
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_ENCRYPTED_PDF' });
  });

  it('権限パスワードだけの PDF(閲覧パスワードなし)も拒否する', async () => {
    // 空のパスワードで復号できてしまうため、ここを素通りさせると編集制限が外れる
    const result = await loadPdfForEdit(await encryptedPdf(''));
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_ENCRYPTED_PDF' });
  });

  it('暗号化されていない PDF は読み込める', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const result = await loadPdfForEdit(await doc.save());
    expect(result.ok).toBe(true);
  });
});

describe('HC-4: 読み込み経路の一本化', () => {
  // src/ の中で PDFDocument.load と、復号・暗号無視のオプションを使ってよいのは pdfLoad.ts だけ
  const srcDir = join(import.meta.dirname, '..', '..', 'src');
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  })(srcDir);

  it.each(files.map((f) => [relative(srcDir, f).replaceAll('\\', '/'), f]))('%s', (rel, path) => {
    const text = readFileSync(path, 'utf8');
    if (rel === 'core/pdfLoad.ts') {
      expect(text).not.toMatch(/ignoreEncryption\s*:/);
      expect(text).not.toMatch(/password\s*:/);
      return;
    }
    expect(text).not.toMatch(/PDFDocument\.load\s*\(/);
    expect(text).not.toMatch(/ignoreEncryption/);
  });
});
