// HC-1 / HC-2 / HC-3 のガード: Content-Security-Policy の単一ソース。
// GitHub Pages では HTTP ヘッダを設定できないため、ビルド時に <meta> として index.html に注入する
// (vite.config.ts)。scripts/verify-dist.mjs と E2E テストがこの値を前提に検証する。
//
// pdf.js のワーカーは blob: URL 経由で生成し、このポリシーを継承させる(src/render/pdfjs.ts)。
// 同一オリジンのスクリプト URL から直接生成したワーカーには <meta> の CSP が効かないため。
//
// このファイルは Node のスクリプトからも直接 import するので、型注釈以外の TS 構文を使わないこと。

export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'none'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'blob:', 'data:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'form-action': ["'none'"],
  'base-uri': ["'none'"],
};

export function buildCspContent(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
