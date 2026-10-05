// pdf.js が実行時に読み込むアセット(CMap、標準フォント、WASM、ICC)を public/pdfjs/ にコピーする。
// HC-2: これらを CDN から読み込まず、成果物に同梱するため。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');
const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

if (!existsSync(src)) {
  console.error('pdfjs-dist が見つかりません。先に npm install を実行してください。');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of dirs) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
cpSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));
console.log(`pdf.js assets copied: ${dirs.join(', ')} -> public/pdfjs/`);
