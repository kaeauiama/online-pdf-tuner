// HC-1 / HC-2 のビルド後検査。npm run build の最後に実行し、違反があれば失敗させる。
//  1. dist/index.html の <head> 先頭に、src/security/csp.ts と同じ CSP の <meta> があること
//  2. HTML / CSS / JS に、外部オリジンからリソースを読み込む記述がないこと
//
// 2 はライブラリ内のコメントやエラーメッセージに含まれる URL まで拾うと誤検知が多いため、
// 「読み込み」の形をした記述(src=, href=, url(), import(), importScripts(), new Worker())に限って検査する。
// 実行時の通信は CSP と E2E テスト(tests/e2e/no-network.spec.ts)で別に担保している。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { buildCspContent } from '../src/security/csp.ts';

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const failures = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// 1. CSP の <meta>(Vite は属性値の ' を &#39; にエスケープするので、戻してから比べる)
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const decode = (s) => s.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const cspMatch = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i.exec(html);
if (!cspMatch) {
  failures.push('index.html: CSP の <meta> がない');
} else {
  if (decode(cspMatch[1]) !== buildCspContent()) {
    failures.push('index.html: CSP の内容が src/security/csp.ts と一致しない');
  }
  // CSP より前に読み込まれたリソースには CSP が効かない
  const firstResource = html.search(/<(script|link|style)\b/i);
  if (firstResource !== -1 && firstResource < cspMatch.index) {
    failures.push('index.html: CSP の <meta> より前に script / link / style がある');
  }
}

// 1b. Service Worker とマニフェスト(M4)
try {
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  if (sw.includes('__VERSION__') || sw.includes('__PRECACHE__')) failures.push('sw.js: 版または事前キャッシュの一覧が埋め込まれていない');
  if (/https?:\/\//.test(sw)) failures.push('sw.js: URL が含まれている(Service Worker から外部に通信するコードは書かない)');
} catch {
  failures.push('sw.js がない');
}
try {
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
  if (JSON.stringify(manifest).match(/https?:\/\//)) failures.push('manifest.webmanifest: 外部の URL が含まれている');
} catch {
  failures.push('manifest.webmanifest がない、または JSON として読めない');
}

// 2. 外部オリジンからの読み込み
const EXTERNAL = String.raw`(?:https?:)?//[^\s"'()]+`;
const patterns = [
  new RegExp(String.raw`\b(?:src|href)\s*=\s*["']${EXTERNAL}`, 'gi'),
  new RegExp(String.raw`url\(\s*["']?${EXTERNAL}`, 'gi'),
  new RegExp(String.raw`@import\s+["']${EXTERNAL}`, 'gi'),
  new RegExp(String.raw`\bimport\(\s*["'\`]${EXTERNAL}`, 'g'),
  new RegExp(String.raw`\bimportScripts\(\s*["'\`]${EXTERNAL}`, 'g'),
  new RegExp(String.raw`new\s+(?:Shared)?Worker\(\s*["'\`]${EXTERNAL}`, 'g'),
];
// SVG 名前空間などの識別子は読み込みではないので除外する
const ALLOWED = [/^(?:https?:)?\/\/www\.w3\.org\//];
// <a> のリンク(利用者が押したときの移動で、読み込みではない)は、このリポジトリへのものだけ許す
const LINKS_ALLOWED = [/^https:\/\/github\.com\/kaeauiama\/online-pdf-tuner(?:[/#?]|$)/];
const isAnchor = (text, index) => /<a\s[^<>]*$/i.test(text.slice(Math.max(0, index - 400), index));

for (const file of walk(dist)) {
  if (!['.html', '.css', '.js', '.mjs'].includes(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const url = match[0].match(new RegExp(EXTERNAL))?.[0] ?? '';
      if (ALLOWED.some((re) => re.test(url))) continue;
      if (/^href/i.test(match[0]) && isAnchor(text, match.index) && LINKS_ALLOWED.some((re) => re.test(url))) continue;
      failures.push(`${relative(dist, file)}: 外部リソースの読み込み ${match[0].slice(0, 120)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('verify-dist: NG');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('verify-dist: OK (CSP meta present, no external resource loads)');
