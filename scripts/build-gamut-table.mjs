// くすみ警告(S2)用の「印刷で出せる色の範囲」の表を作る開発用スクリプト。
// 使い方: node scripts/build-gamut-table.mjs  → src/print/gamutTable.ts を書き出す
//
// 基準のプロファイル(D-029):
//  1. .cache/JapanColor2011Coated.icc があればそれを使う(Japan Color 2011 Coated。ICC の登録簿から入手。
//     「制限なく使用・共有してよい。改変・販売は不可」。プロファイル自体はリポジトリに入れず、計算した表の数値だけを使う)
//     入手: https://registry.color.org/profile-registry/profiles/JapanColor2011Coated.icc を .cache/ に保存する
//  2. なければ pdfjs-dist 同梱の CGATS001Compat-v2-micro.icc(CC0。米国のオフセット印刷の標準 CGATS TR 001 相当)
// CMYK の格子点を Lab(D50、相対的な色域を維持)に変換し、明度 L と色相 h ごとに、出せる最大の彩度 C を記録する。
// 実行時は lcms を使わず、この表と sRGB → Lab の計算式(src/print/gamut.ts)だけで判定する。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiate, INTENT_RELATIVE_COLORIMETRIC } from 'lcms-wasm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAPAN_COLOR = '.cache/JapanColor2011Coated.icc';
const useJapanColor = existsSync(join(root, JAPAN_COLOR));
const PROFILE = useJapanColor ? JAPAN_COLOR : 'node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc';
const SOURCE = useJapanColor
  ? 'Japan Color 2011 Coated(JapanColor2011Coated.icc、日本印刷産業機械工業会。ICC の登録簿で入手。改変・販売不可、使用・共有は自由)'
  : 'CGATS001Compat-v2-micro.icc(CC0。米国のオフセット印刷の標準 CGATS TR 001 相当)';
const SOURCE_SHORT = useJapanColor ? 'Japan Color 2011 Coated' : 'CGATS TR 001(米国のオフセット印刷の標準)';
const L_STEP = 2;
const H_STEP = 5;
const L_BINS = 100 / L_STEP + 1;
const H_BINS = 360 / H_STEP;

// lcms2.h: FLOAT_SH(1) | COLORSPACE_SH(PT_xxx) | CHANNELS_SH(n) | BYTES_SH(4)
const TYPE_CMYK_FLT = (1 << 22) | (6 << 16) | (4 << 3) | 4;
const TYPE_Lab_FLT = (1 << 22) | (10 << 16) | (3 << 3) | 4;
const TYPE_RGB_FLT = (1 << 22) | (4 << 16) | (3 << 3) | 4;

const lcms = await instantiate();
const icc = new Uint8Array(readFileSync(join(root, PROFILE)));
const cmykProfile = lcms.cmsOpenProfileFromMem(icc, icc.byteLength);
const labProfile = lcms.cmsCreateLab4Profile(null);
if (!cmykProfile || !labProfile) throw new Error('profile load failed');

// CMYK の格子点 → Lab
const cmykToLab = lcms.cmsCreateTransform(cmykProfile, TYPE_CMYK_FLT, labProfile, TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, 0);
const samples = [];
for (let c = 0; c <= 100; c += 5) for (let m = 0; m <= 100; m += 5) for (let y = 0; y <= 100; y += 5) for (let k = 0; k <= 100; k += 10) samples.push(c, m, y, k);
const lab = lcms.cmsDoTransform(cmykToLab, Float32Array.from(samples), samples.length / 4);

const maxC = new Float64Array(L_BINS * H_BINS);
let minL = Infinity;
let maxL = -Infinity;
for (let i = 0; i < lab.length; i += 3) {
  const L = lab[i];
  const C = Math.hypot(lab[i + 1], lab[i + 2]);
  const h = ((Math.atan2(lab[i + 2], lab[i + 1]) * 180) / Math.PI + 360) % 360;
  minL = Math.min(minL, L);
  maxL = Math.max(maxL, L);
  // 隣の明度の区間にも入れて、格子の粗さによる穴を埋める
  const l0 = Math.floor(L / L_STEP);
  const hb = Math.round(h / H_STEP) % H_BINS;
  for (const lb of [l0, l0 + 1]) {
    if (lb < 0 || lb >= L_BINS) continue;
    const idx = lb * H_BINS + hb;
    if (C > maxC[idx]) maxC[idx] = C;
  }
}

// 色相方向にも隣と最大を取ってならす(サンプリングの隙間による偽の「範囲外」を避ける)
const smoothed = new Float64Array(maxC.length);
for (let lb = 0; lb < L_BINS; lb++) {
  for (let hb = 0; hb < H_BINS; hb++) {
    let v = 0;
    for (const d of [-1, 0, 1]) v = Math.max(v, maxC[lb * H_BINS + ((hb + d + H_BINS) % H_BINS)]);
    smoothed[lb * H_BINS + hb] = v;
  }
}

// 検証: 実行時に使う sRGB → Lab の計算式が、lcms の sRGB プロファイルの結果と一致するか
const srgb = lcms.cmsCreate_sRGBProfile();
const rgbToLab = lcms.cmsCreateTransform(srgb, TYPE_RGB_FLT, labProfile, TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, 0);
const probes = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0.5, 0.5, 0.5], [0.9, 0.6, 0.5], [0.1, 0.2, 0.6], [1, 1, 1]];
const ref = lcms.cmsDoTransform(rgbToLab, Float32Array.from(probes.flat()), probes.length);
let maxDiff = 0;
probes.forEach(([r, g, b], i) => {
  const mine = srgbToLabD50(r, g, b);
  for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(mine[k] - ref[i * 3 + k]));
});
console.log(`sRGB→Lab: max difference vs lcms = ${maxDiff.toFixed(3)}`);
if (maxDiff > 1) throw new Error('sRGB→Lab formula does not match lcms');

function srgbToLabD50(r, g, b) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X / 0.9642);
  const fy = f(Y / 1.0);
  const fz = f(Z / 0.8249);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const values = Array.from(smoothed, (v) => Math.round(v));
const out = `// 自動生成: node scripts/build-gamut-table.mjs(手で編集しないこと)
// 基準: ${SOURCE}
// 相対的な色域を維持(INTENT_RELATIVE_COLORIMETRIC)で CMYK を Lab(D50)に変換し、明度・色相ごとの最大彩度を記録した。
// 印刷所・紙・印刷方式(オフセット / オンデマンド)によって実際の色域は異なるため、くすみ警告はあくまで目安として扱う。

export const GAMUT_SOURCE = '${SOURCE_SHORT}';
export const GAMUT_L_STEP = ${L_STEP};
export const GAMUT_H_STEP = ${H_STEP};
export const GAMUT_L_BINS = ${L_BINS};
export const GAMUT_H_BINS = ${H_BINS};
/** 印刷で出せる明度の範囲(紙の白 = 100) */
export const GAMUT_MIN_L = ${minL.toFixed(1)};
export const GAMUT_MAX_L = ${maxL.toFixed(1)};

/** [明度の区間 × 色相の区間] ごとの最大彩度(C*ab、整数に丸めた値) */
export const GAMUT_MAX_CHROMA = Uint8Array.from([
${chunk(values, H_BINS).map((row) => `  ${row.join(', ')},`).join('\n')}
]);
`;
writeFileSync(join(root, 'src/print/gamutTable.ts'), out);
console.log(`written: src/print/gamutTable.ts (L ${minL.toFixed(1)}..${maxL.toFixed(1)}, ${samples.length / 4} samples)`);

function chunk(arr, n) {
  const rows = [];
  for (let i = 0; i < arr.length; i += n) rows.push(arr.slice(i, i + n));
  return rows;
}
