// RGB → CMYK の変換(D-035、純粋関数)。変換表は cmykLut.ts(Japan Color 2011 Coated、開発時に lcms で計算)。
//
// - 写真などの画像: 変換表を四面体補間する(Photoshop の「相対的な色域を維持 + 黒点の補正」と同じ考え方)
// - 文字・線・図形の色: 無彩色(R = G = B)は K だけにする(黒い文字や罫線が 4 色の版ズレでにじまないように。
//   PDF のグレー(DeviceGray)を K に対応させる慣例と同じ)。それ以外は画像と同じ変換
import { labToSrgb } from './gamut.ts';
import { CMYK_LUT_BASE64, CMYK_LUT_GRID } from './cmykLut.ts';

export type Cmyk = [number, number, number, number];

let table: Uint8Array | undefined;
function lut(): Uint8Array {
  if (!table) {
    const bin = atob(CMYK_LUT_BASE64);
    table = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) table[i] = bin.charCodeAt(i);
  }
  return table;
}

/** RGB(0〜1)→ CMYK(0〜1)。変換表の四面体補間 */
export function rgbToCmyk(r: number, g: number, b: number): Cmyk {
  const t = lut();
  const n = CMYK_LUT_GRID - 1;
  const clamp = (v: number) => Math.min(n, Math.max(0, v * n));
  const fr = clamp(r);
  const fg = clamp(g);
  const fb = clamp(b);
  const r0 = Math.min(Math.floor(fr), n - 1);
  const g0 = Math.min(Math.floor(fg), n - 1);
  const b0 = Math.min(Math.floor(fb), n - 1);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const idx = (ri: number, gi: number, bi: number) => (((r0 + ri) * CMYK_LUT_GRID + (g0 + gi)) * CMYK_LUT_GRID + (b0 + bi)) * 4;
  const c000 = idx(0, 0, 0);
  const c111 = idx(1, 1, 1);
  // 立方体を 6 つの四面体に分け、点を含む四面体の 4 頂点で補間する
  let w: [number, number, number, number];
  let v1: number;
  let v2: number;
  if (dr >= dg && dg >= db) {
    v1 = idx(1, 0, 0);
    v2 = idx(1, 1, 0);
    w = [1 - dr, dr - dg, dg - db, db];
  } else if (dr >= db && db >= dg) {
    v1 = idx(1, 0, 0);
    v2 = idx(1, 0, 1);
    w = [1 - dr, dr - db, db - dg, dg];
  } else if (db >= dr && dr >= dg) {
    v1 = idx(0, 0, 1);
    v2 = idx(1, 0, 1);
    w = [1 - db, db - dr, dr - dg, dg];
  } else if (dg >= dr && dr >= db) {
    v1 = idx(0, 1, 0);
    v2 = idx(1, 1, 0);
    w = [1 - dg, dg - dr, dr - db, db];
  } else if (dg >= db && db >= dr) {
    v1 = idx(0, 1, 0);
    v2 = idx(0, 1, 1);
    w = [1 - dg, dg - db, db - dr, dr];
  } else {
    v1 = idx(0, 0, 1);
    v2 = idx(0, 1, 1);
    w = [1 - db, db - dg, dg - dr, dr];
  }
  const out: Cmyk = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) out[k] = (w[0] * t[c000 + k] + w[1] * t[v1 + k] + w[2] * t[v2 + k] + w[3] * t[c111 + k]) / 255;
  return out;
}

/** 無彩色とみなす RGB の差の許容(0〜1) */
const NEUTRAL_TOLERANCE = 0.02;

/** 文字・線・図形の色の RGB → CMYK: 無彩色は K だけ */
export function vectorRgbToCmyk(r: number, g: number, b: number): Cmyk {
  if (Math.abs(r - g) <= NEUTRAL_TOLERANCE && Math.abs(g - b) <= NEUTRAL_TOLERANCE && Math.abs(r - b) <= NEUTRAL_TOLERANCE) {
    return [0, 0, 0, 1 - (r + g + b) / 3];
  }
  return rgbToCmyk(r, g, b);
}

/** グレー(0 = 黒、1 = 白)→ K だけの CMYK */
export function grayToCmyk(g: number): Cmyk {
  return [0, 0, 0, 1 - g];
}

/** Lab(D50)→ CMYK(sRGB を経由する目安) */
export function labToCmyk(L: number, a: number, b: number, vector: boolean): Cmyk {
  const [r, g, bb] = labToSrgb(L, a, b);
  return vector ? vectorRgbToCmyk(r / 255, g / 255, bb / 255) : rgbToCmyk(r / 255, g / 255, bb / 255);
}

/** リッチブラック(K が多く、C・M・Y も混ざった黒) */
export function isRichBlackCmyk([c, m, y, k]: readonly number[], minK: number, minCmy: number): boolean {
  return k >= minK && c + m + y >= minCmy;
}

/** RGBA(8 ビット)の画素を CMYK(8 ビット、4 チャンネル)にする。同じ色は覚えておいて計算を省く */
export function convertRgbPixels(rgb: Uint8Array | Uint8ClampedArray, channels: 3 | 4, count: number): Uint8Array {
  const out = new Uint8Array(count * 4);
  const cache = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const s = i * channels;
    const key = (rgb[s] << 16) | (rgb[s + 1] << 8) | rgb[s + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      const [c, m, y, k] = rgbToCmyk(rgb[s] / 255, rgb[s + 1] / 255, rgb[s + 2] / 255);
      packed = ((Math.round(c * 255) << 24) | (Math.round(m * 255) << 16) | (Math.round(y * 255) << 8) | Math.round(k * 255)) >>> 0;
      cache.set(key, packed);
    }
    out[i * 4] = packed >>> 24;
    out[i * 4 + 1] = (packed >>> 16) & 0xff;
    out[i * 4 + 2] = (packed >>> 8) & 0xff;
    out[i * 4 + 3] = packed & 0xff;
  }
  return out;
}
