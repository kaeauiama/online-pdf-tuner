// くすみ警告(S2): 画面の色(sRGB)が、印刷(CMYK)で出せる色の範囲を超えているかを調べる(純粋関数)。
// 出力の PDF は変えない(D-008 / D-013)。判定の基準は gamutTable.ts(CC0 のプロファイルから生成した目安)。
import {
  GAMUT_H_BINS,
  GAMUT_H_STEP,
  GAMUT_L_BINS,
  GAMUT_L_STEP,
  GAMUT_MAX_CHROMA,
  GAMUT_MAX_L,
  GAMUT_MIN_L,
} from './gamutTable.ts';
import type { Rect } from './geometry.ts';
import { GAMUT_MODERATE_DELTA_C, GAMUT_STRONG_DELTA_C } from './thresholds.ts';

// D50 の基準白(ICC の Lab の基準)
const XN = 0.9642;
const YN = 1.0;
const ZN = 0.8249;

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

/** sRGB(0〜255)→ Lab(D50) */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LINEAR[r];
  const G = LINEAR[g];
  const B = LINEAR[b];
  const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  const fy = f(Y / YN);
  return [116 * fy - 16, 500 * (f(X / XN) - fy), 200 * (fy - f(Z / ZN))];
}

function encode(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Lab(D50)→ sRGB(0〜255、範囲外は丸める) */
export function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const X = XN * fInv(fy + a / 500);
  const Y = YN * fInv(fy);
  const Z = ZN * fInv(fy - b / 200);
  const R = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const G = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const B = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  return [encode(R), encode(G), encode(B)];
}

/** 明度 L・色相 h(度)で、印刷で出せる最大の彩度(表を双線形補間) */
export function maxChromaAt(L: number, h: number): number {
  const l = Math.max(GAMUT_MIN_L, Math.min(GAMUT_MAX_L, L)) / GAMUT_L_STEP;
  const l0 = Math.min(Math.floor(l), GAMUT_L_BINS - 2);
  const tl = l - l0;
  const hh = (((h % 360) + 360) % 360) / GAMUT_H_STEP;
  const h0 = Math.floor(hh) % GAMUT_H_BINS;
  const h1 = (h0 + 1) % GAMUT_H_BINS;
  const th = hh - Math.floor(hh);
  const at = (lb: number, hb: number) => GAMUT_MAX_CHROMA[lb * GAMUT_H_BINS + hb];
  const v0 = at(l0, h0) * (1 - th) + at(l0, h1) * th;
  const v1 = at(l0 + 1, h0) * (1 - th) + at(l0 + 1, h1) * th;
  return v0 * (1 - tl) + v1 * tl;
}

/** 印刷で出せる彩度を超えている量(超えていなければ 0) */
export function chromaExcess(r: number, g: number, b: number): number {
  const [L, a, bb] = srgbToLab(r, g, b);
  const C = Math.hypot(a, bb);
  if (C < 20) return 0; // 彩度の低い色は、どの明度でも印刷で出せる(計算を省く)
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return Math.max(0, C - maxChromaAt(L, h));
}

export interface GamutStats {
  /** 調べた画素数(透明な画素を除く) */
  readonly pixels: number;
  /** くすみやすい画素(彩度の超過が GAMUT_MODERATE_DELTA_C 以上) */
  readonly moderate: number;
  /** 大きくくすむ画素(GAMUT_STRONG_DELTA_C 以上) */
  readonly strong: number;
}

/** RGBA の画素(左上原点)のうち、region の内側を調べる */
export function measureGamut(data: Uint8ClampedArray, width: number, height: number, region?: Rect): GamutStats {
  const x0 = Math.max(0, Math.floor(region?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y0 ?? 0));
  const x1 = Math.min(width, Math.ceil(region?.x1 ?? width));
  const y1 = Math.min(height, Math.ceil(region?.y1 ?? height));
  const cache = new Map<number, number>();
  let pixels = 0;
  let moderate = 0;
  let strong = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 16) continue;
      pixels++;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let excess = cache.get(key);
      if (excess === undefined) {
        excess = chromaExcess(data[i], data[i + 1], data[i + 2]);
        cache.set(key, excess);
      }
      if (excess >= GAMUT_STRONG_DELTA_C) strong++;
      if (excess >= GAMUT_MODERATE_DELTA_C) moderate++;
    }
  }
  return { pixels, moderate, strong };
}

/** 印刷のおおよその見え方: 出せない彩度を、明度と色相を保ったまま範囲内に寄せる(目安) */
export function simulatePrint(data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data);
  const cache = new Map<number, number>();
  for (let i = 0; i < out.length; i += 4) {
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let packed = cache.get(key);
    if (packed === undefined) {
      packed = key;
      const [L, a, b] = srgbToLab(out[i], out[i + 1], out[i + 2]);
      const C = Math.hypot(a, b);
      if (C >= 20) {
        const h = (Math.atan2(b, a) * 180) / Math.PI;
        const max = maxChromaAt(L, h);
        if (C > max) {
          const k = max / C;
          const [r, g, bb] = labToSrgb(L, a * k, b * k);
          packed = (r << 16) | (g << 8) | bb;
        }
      }
      cache.set(key, packed);
    }
    out[i] = packed >> 16;
    out[i + 1] = (packed >> 8) & 0xff;
    out[i + 2] = packed & 0xff;
  }
  return out;
}

/** くすみやすい所の表示: 範囲内の色は薄い灰色にし、くすみやすい色だけを元の色で残す */
export function highlightOutOfGamut(data: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data);
  const cache = new Map<number, number>();
  for (let i = 0; i < out.length; i += 4) {
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let excess = cache.get(key);
    if (excess === undefined) {
      excess = chromaExcess(out[i], out[i + 1], out[i + 2]);
      cache.set(key, excess);
    }
    if (excess >= GAMUT_MODERATE_DELTA_C) continue;
    const gray = Math.round(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2]);
    const light = Math.round(180 + gray * 0.29); // 薄くして、残した色を目立たせる
    out[i] = light;
    out[i + 1] = light;
    out[i + 2] = light;
  }
  return out;
}
