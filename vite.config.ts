/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { buildCspContent } from './src/security/csp.ts';

// M4: ビルド成果物の一覧を Service Worker のテンプレートに埋め込み、dist/sw.js を書き出す。
// 版(VERSION)は全ファイルの中身から計算するので、何かが変われば新しい版として配信される。
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        });
      const files = walk(outDir)
        .map((p) => relative(outDir, p).replaceAll('\\', '/'))
        .filter((p) => p !== 'sw.js')
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync('src/sw/sw-template.js', 'utf8');
      const sw = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(['./', ...files], null, 2));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

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
  plugins: [injectCsp(), serviceWorker()],
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
