import { defineConfig } from '@playwright/test';

const PORT = 4173;

// ビルド成果物(dist/)を vite preview で配信して検証する。GitHub Pages に置くものと同じで、CSP も有効。
// ブラウザは Windows に入っている Edge を使う(Playwright のブラウザをダウンロードしない)。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    acceptDownloads: true,
  },
  webServer: {
    command: 'npm run preview',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
