/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { buildCspContent } from './src/security/csp.ts';

// ビルド成果物にだけ CSP の <meta> を注入する。
// 開発サーバーは HMR にインラインスクリプトと WebSocket を使うため、CSP を付けると動かない。
function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCspContent() },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

export default defineConfig({
  // GitHub Pages のサブパス(/<repo>/)でも動くように相対パスで出力する
  base: './',
  plugins: [injectCsp()],
  build: {
    target: 'es2022',
    // ソースマップは公開しても害はないが、成果物の監査対象を増やさないため出力しない
    sourcemap: false,
    // pdf.js と pdf-lib を含むため、本体は 1MB 前後になる(gzip 後 約 400KB)
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
