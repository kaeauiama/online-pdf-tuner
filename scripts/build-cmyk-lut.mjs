// CMYK 変換(D-035)用の変換表を作る開発用スクリプト。
// 使い方: node scripts/build-cmyk-lut.mjs  → src/print/cmykLut.ts を書き出す
//
// sRGB → Japan Color 2011 Coated(.cache/JapanColor2011Coated.icc)を、相対的な色域を維持 + 黒点の補正で変換した
// 33 × 33 × 33 の格子の CMYK の値を記録する。プロファイル自体はリポジトリに入れず、計算した表の数値だけを使う(D-029 と同じ扱い)。
// 入手: https://registry.color.org/profile-registry/profiles/JapanColor2011Coated.icc を .cache/ に保存する
// 実行時は lcms を使わず、この表の補間(src/print/cmyk.ts)だけで変換する。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiate, INTENT_RELATIVE_COLORIMETRIC } from 'lcms-wasm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(root, '.cache/JapanColor2011Coated.icc');
if (!existsSync(PROFILE)) throw new Error(`${PROFILE} がありません。冒頭の説明に従って入手してください`);

const GRID = 33;
// lcms2.h: COLORSPACE_SH(PT_xxx) | CHANNELS_SH(n) | BYTES_SH(1)
const TYPE_RGB_8 = (4 << 16) | (3 << 3) | 1;
const TYPE_CMYK_8 = (6 << 16) | (4 << 3) | 1;
const cmsFLAGS_BLACKPOINTCOMPENSATION = 0x2000;

const lcms = await instantiate();
const icc = new Uint8Array(readFileSync(PROFILE));
const cmyk = lcms.cmsOpenProfileFromMem(icc, icc.byteLength);
const srgb = lcms.cmsCreate_sRGBProfile();
if (!cmyk || !srgb) throw new Error('profile load failed');
const transform = lcms.cmsCreateTransform(srgb, TYPE_RGB_8, cmyk, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_BLACKPOINTCOMPENSATION);

// 格子点: r → g → b の順(b が最も内側)
const level = (i) => Math.round((i * 255) / (GRID - 1));
const input = new Uint8Array(GRID ** 3 * 3);
let o = 0;
for (let r = 0; r < GRID; r++) for (let g = 0; g < GRID; g++) for (let b = 0; b < GRID; b++) input.set([level(r), level(g), level(b)], (o++) * 3);
const output = lcms.cmsDoTransform(transform, input, GRID ** 3);

// 確認: 白はインキなし、総インキ量は Japan Color の上限(350%)付近まで
const at = (r, g, b) => Array.from(output.slice(((r * GRID + g) * GRID + b) * 4, ((r * GRID + g) * GRID + b) * 4 + 4));
const white = at(GRID - 1, GRID - 1, GRID - 1);
if (white.some((v) => v > 0)) throw new Error(`white is not 0: ${white}`);
let maxTac = 0;
for (let i = 0; i < output.length; i += 4) maxTac = Math.max(maxTac, output[i] + output[i + 1] + output[i + 2] + output[i + 3]);
const pct = (v) => Math.round((v / 255) * 100);
console.log(`black → ${at(0, 0, 0).map(pct)}%, red → ${at(GRID - 1, 0, 0).map(pct)}%, max TAC ${Math.round((maxTac / 255) * 100)}%`);

const base64 = Buffer.from(output).toString('base64');
const out = `// 自動生成: node scripts/build-cmyk-lut.mjs(手で編集しないこと)
// sRGB → Japan Color 2011 Coated(相対的な色域を維持 + 黒点の補正)の変換表。格子は ${GRID}³ 点、r → g → b の順(b が最も内側)。
// 値は C, M, Y, K を 0〜255(255 = 100%)で並べたもの。プロファイル自体は同梱しない(D-029 / D-035)。

export const CMYK_LUT_SOURCE = 'Japan Color 2011 Coated';
export const CMYK_LUT_GRID = ${GRID};
export const CMYK_LUT_BASE64 =
  '${base64}';
`;
writeFileSync(join(root, 'src/print/cmykLut.ts'), out);
console.log(`written: src/print/cmykLut.ts (${output.length} bytes → ${base64.length} chars)`);
