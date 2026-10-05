// PDF を編集用に読み込む唯一の入口。
//
// HC-4 のガード: @cantoo/pdf-lib は load() に password を渡すと(空文字でも)復号し、
// 保存時に暗号化を外す。権限パスワードだけで保護された PDF(閲覧にパスワード不要なもの)も
// これで制限が外れてしまうため、password と ignoreEncryption は一切渡さない。
// 暗号化された PDF は UNSUPPORTED_ENCRYPTED_PDF で止める。
// tests/unit/hc4-encryption.test.ts が、この挙動と「他のファイルで load オプションを使っていないこと」を検証する。
import { EncryptedPDFError, PDFDocument } from '@cantoo/pdf-lib';
import { fail, ok, ReasonError, type Result } from './reasons.ts';

export async function loadPdfForEdit(bytes: Uint8Array): Promise<Result<PDFDocument>> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // 念のため二重に確認する(ライブラリの挙動が変わっても素通りさせない)
    if (doc.isEncrypted) return fail('UNSUPPORTED_ENCRYPTED_PDF');
    return ok(doc);
  } catch (e) {
    if (e instanceof EncryptedPDFError) return fail('UNSUPPORTED_ENCRYPTED_PDF');
    return fail('INVALID_PDF', e instanceof Error ? e.message : undefined);
  }
}

/** loadPdfForEdit の結果を、失敗時に ReasonError を投げる形で受け取る */
export async function loadPdfForEditOrThrow(bytes: Uint8Array): Promise<PDFDocument> {
  const result = await loadPdfForEdit(bytes);
  if (!result.ok) throw new ReasonError(result.code, result.detail);
  return result.value;
}
