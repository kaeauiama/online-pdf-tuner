// 色空間(ColorSpace)の解釈。入稿チェック(色の種類・特色・レジストレーション)と、色の変換(CMYK 化)で使う。
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';

/** 印刷の観点での色の分類 */
export type ColorFamily = 'rgb' | 'cmyk' | 'gray' | 'spot' | 'other';

export type SpaceKind = 'gray' | 'rgb' | 'cmyk' | 'lab' | 'indexed' | 'separation' | 'devicen' | 'pattern' | 'unknown';

export interface ColorSpaceInfo {
  readonly kind: SpaceKind;
  /** 色の成分の数(sc / scn のオペランドの数) */
  readonly n: number;
  readonly family: ColorFamily;
  /** Separation / DeviceN の色版の名前 */
  readonly names?: readonly string[];
  /** Indexed の元の色空間、Separation / DeviceN の代替の色空間 */
  readonly base?: ColorSpaceInfo;
  /** ICCBased・CalRGB・CalGray(デバイスの色空間と同じに扱う) */
  readonly calibrated?: boolean;
  /** 元の色空間のオブジェクト(配列・辞書の参照など) */
  readonly obj?: PDFObject;
}

const N = (s: string) => PDFName.of(s);

export const DEVICE_GRAY: ColorSpaceInfo = { kind: 'gray', n: 1, family: 'gray' };
export const DEVICE_RGB: ColorSpaceInfo = { kind: 'rgb', n: 3, family: 'rgb' };
export const DEVICE_CMYK: ColorSpaceInfo = { kind: 'cmyk', n: 4, family: 'cmyk' };
const UNKNOWN: ColorSpaceInfo = { kind: 'unknown', n: 0, family: 'other' };
const PATTERN: ColorSpaceInfo = { kind: 'pattern', n: 0, family: 'other' };

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function deviceSpace(name: string): ColorSpaceInfo | undefined {
  switch (name) {
    case 'DeviceGray':
    case 'G':
      return DEVICE_GRAY;
    case 'DeviceRGB':
    case 'RGB':
      return DEVICE_RGB;
    case 'DeviceCMYK':
    case 'CMYK':
      return DEVICE_CMYK;
    case 'Pattern':
      return PATTERN;
    default:
      return undefined;
  }
}

/** 色空間を解釈する。cs は名前(資源の ColorSpace 辞書で引く)か、配列 */
export function resolveColorSpace(doc: PDFDocument, cs: PDFObject | undefined, resources: PDFDict | undefined, depth = 0): ColorSpaceInfo {
  const v = resolve(doc, cs);
  if (depth > 6 || v === undefined) return UNKNOWN;
  if (v instanceof PDFName) {
    const name = v.decodeText();
    const device = deviceSpace(name);
    if (device) return device;
    const named = resources?.lookupMaybe(N('ColorSpace'), PDFDict)?.get(N(name));
    return named ? resolveColorSpace(doc, named, resources, depth + 1) : UNKNOWN;
  }
  if (!(v instanceof PDFArray)) return UNKNOWN;
  const kind = (resolve(doc, v.get(0)) as PDFName | undefined)?.decodeText?.();
  switch (kind) {
    case 'ICCBased': {
      const stream = resolve(doc, v.get(1));
      const n = stream instanceof PDFStream ? (resolve(doc, stream.dict.get(N('N'))) as PDFNumber | undefined)?.asNumber() : undefined;
      const base = n === 1 ? DEVICE_GRAY : n === 3 ? DEVICE_RGB : n === 4 ? DEVICE_CMYK : undefined;
      return base ? { ...base, calibrated: true, obj: v } : { ...UNKNOWN, obj: v };
    }
    case 'CalRGB':
      return { ...DEVICE_RGB, calibrated: true, obj: v };
    case 'CalGray':
      return { ...DEVICE_GRAY, calibrated: true, obj: v };
    case 'Lab':
      return { kind: 'lab', n: 3, family: 'other', obj: v };
    case 'Indexed':
    case 'I': {
      const base = resolveColorSpace(doc, v.get(1), resources, depth + 1);
      return { kind: 'indexed', n: 1, family: base.family, base, obj: v };
    }
    case 'Separation': {
      const name = (resolve(doc, v.get(1)) as PDFName | undefined)?.decodeText?.() ?? '';
      const base = resolveColorSpace(doc, v.get(2), resources, depth + 1);
      return { kind: 'separation', n: 1, family: 'spot', names: [name], base, obj: v };
    }
    case 'DeviceN': {
      const namesArr = resolve(doc, v.get(1));
      const names = namesArr instanceof PDFArray ? namesArr.asArray().map((x) => (resolve(doc, x) as PDFName | undefined)?.decodeText?.() ?? '') : [];
      const base = resolveColorSpace(doc, v.get(2), resources, depth + 1);
      return { kind: 'devicen', n: names.length, family: 'spot', names, base, obj: v };
    }
    case 'Pattern':
      return { ...PATTERN, obj: v };
    default: {
      const device = deviceSpace(kind ?? '');
      return device ?? { ...UNKNOWN, obj: v };
    }
  }
}

/** 色空間を選んだ直後の色(PDF の仕様の初期値) */
export function initialColor(space: ColorSpaceInfo): number[] {
  switch (space.kind) {
    case 'cmyk':
      return [0, 0, 0, 1];
    case 'separation':
    case 'devicen':
      return Array.from({ length: space.n }, () => 1);
    case 'lab':
      return [0, 0, 0];
    default:
      return Array.from({ length: space.n }, () => 0);
  }
}

/** DeviceN の色版の名前のうち、プロセス 4 色(特色ではないもの) */
export const PROCESS_COLORANTS = new Set(['Cyan', 'Magenta', 'Yellow', 'Black', 'None']);
