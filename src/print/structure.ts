// PDF の構造から、入稿チェックに必要な事実を取り出す(pdf-lib + 自前のコンテンツ解析)。
// ページの寸法・フォントの埋め込み・画像の配置と実効解像度・色の種類・透明効果・注釈。
import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { lexContent, name as opName, num, type Operand } from '../pdf/lexer.ts';
import { IDENTITY, multiply, rect, unitSquareBounds, unitSquareSize, type Matrix, type Rect } from './geometry.ts';

export type ColorFamily = 'rgb' | 'cmyk' | 'gray' | 'spot' | 'other';

export interface ImagePlacement {
  readonly name: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** ページ上の描画範囲(pt、ページ座標) */
  readonly bounds: Rect;
  /** 実効解像度(縦横の小さい方、ppi) */
  readonly dpi: number;
  readonly color: ColorFamily;
  readonly isMask: boolean;
  /** 圧縮後のデータの大きさ(バイト)。インライン画像など不明な場合は undefined */
  readonly encodedBytes?: number;
}

export interface FontInfo {
  readonly name: string;
  readonly subtype: string;
  readonly embedded: boolean;
}

export interface PageStructure {
  readonly index: number;
  readonly mediaBox: Rect;
  /** 表示範囲(CropBox。なければ MediaBox) */
  readonly cropBox: Rect;
  /** 明示されている場合のみ */
  readonly trimBox?: Rect;
  readonly bleedBox?: Rect;
  readonly rotation: number;
  readonly fonts: readonly FontInfo[];
  readonly annotations: { readonly links: number; readonly widgets: number; readonly others: number };
  readonly images: readonly ImagePlacement[];
  readonly colorUse: Readonly<Record<ColorFamily, number>>;
  readonly transparency: boolean;
}

const N = (s: string) => PDFName.of(s);

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function dictOf(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(doc, obj);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

function numberOf(doc: PDFDocument, obj: PDFObject | undefined): number | undefined {
  const v = resolve(doc, obj);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function nameOf(doc: PDFDocument, obj: PDFObject | undefined): string | undefined {
  const v = resolve(doc, obj);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  const s = stream as PDFStream & { getUnencodedContents?: () => Uint8Array };
  return s.getUnencodedContents ? s.getUnencodedContents() : stream.getContents();
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    out[o + p.length] = 0x0a;
    o += p.length + 1;
  }
  return out;
}

export function pageContentBytes(doc: PDFDocument, page: PDFPage): Uint8Array {
  const contents = resolve(doc, page.node.get(N('Contents')));
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (const item of contents.asArray()) {
      const s = resolve(doc, item);
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  return concatBytes(streams.map(streamBytes));
}

// ---------- 色空間 ----------

function familyOfColorSpace(doc: PDFDocument, cs: PDFObject | undefined, resources: PDFDict | undefined, depth = 0): ColorFamily {
  const v = resolve(doc, cs);
  if (depth > 5 || v === undefined) return 'other';
  if (v instanceof PDFName) {
    const n = v.decodeText();
    const device = deviceFamily(n);
    if (device) return device;
    const named = dictOf(doc, resources?.get(N('ColorSpace')))?.get(N(n));
    return named ? familyOfColorSpace(doc, named, resources, depth + 1) : 'other';
  }
  if (v instanceof PDFArray) {
    const kind = nameOf(doc, v.get(0));
    switch (kind) {
      case 'ICCBased': {
        const n = numberOf(doc, dictOf(doc, v.get(1))?.get(N('N')));
        return n === 3 ? 'rgb' : n === 4 ? 'cmyk' : n === 1 ? 'gray' : 'other';
      }
      case 'CalRGB':
        return 'rgb';
      case 'CalGray':
        return 'gray';
      case 'Indexed':
      case 'I':
        return familyOfColorSpace(doc, v.get(1), resources, depth + 1);
      case 'Separation':
      case 'DeviceN':
        return 'spot';
      default:
        return deviceFamily(kind ?? '') ?? 'other';
    }
  }
  return 'other';
}

function deviceFamily(n: string): ColorFamily | undefined {
  if (n === 'DeviceRGB' || n === 'RGB') return 'rgb';
  if (n === 'DeviceCMYK' || n === 'CMYK') return 'cmyk';
  if (n === 'DeviceGray' || n === 'G') return 'gray';
  return undefined;
}

/** インライン画像の色空間(省略形あり)を判定する */
function familyOfInlineColorSpace(doc: PDFDocument, cs: Operand | undefined, resources: PDFDict | undefined): ColorFamily {
  if (!cs) return 'other';
  if (cs.type === 'name') return deviceFamily(cs.value) ?? familyOfColorSpace(doc, N(cs.value), resources);
  if (cs.type === 'array') {
    const head = opName(cs.items[0]);
    if (head === 'I' || head === 'Indexed') return familyOfInlineColorSpace(doc, cs.items[1], resources);
  }
  return 'other';
}

// ---------- 透明 ----------

function extGStateHasTransparency(doc: PDFDocument, gs: PDFDict): boolean {
  const ca = numberOf(doc, gs.get(N('ca')));
  const CA = numberOf(doc, gs.get(N('CA')));
  if ((ca !== undefined && ca < 1) || (CA !== undefined && CA < 1)) return true;
  const smask = resolve(doc, gs.get(N('SMask')));
  if (smask instanceof PDFDict) return true;
  const bm = resolve(doc, gs.get(N('BM')));
  const modes = bm instanceof PDFArray ? bm.asArray().map((m) => nameOf(doc, m)) : [nameOf(doc, bm)];
  return modes.some((m) => m !== undefined && m !== 'Normal' && m !== 'Compatible');
}

// ---------- フォント ----------

function fontInfo(doc: PDFDocument, font: PDFDict): FontInfo {
  const subtype = nameOf(doc, font.get(N('Subtype'))) ?? '?';
  const baseFont = nameOf(doc, font.get(N('BaseFont'))) ?? '(名前なし)';
  const displayName = baseFont.replace(/^[A-Z]{6}\+/, '');
  if (subtype === 'Type3') return { name: displayName, subtype, embedded: true };
  let descriptor = dictOf(doc, font.get(N('FontDescriptor')));
  if (subtype === 'Type0') {
    const descendants = resolve(doc, font.get(N('DescendantFonts')));
    if (descendants instanceof PDFArray) descriptor = dictOf(doc, dictOf(doc, descendants.get(0))?.get(N('FontDescriptor')));
  }
  const embedded = !!descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor!.has(N(k)));
  return { name: displayName, subtype, embedded };
}

// ---------- コンテンツの解析 ----------

interface ScanState {
  readonly doc: PDFDocument;
  readonly images: ImagePlacement[];
  readonly colorUse: Record<ColorFamily, number>;
  readonly fonts: Map<string, FontInfo>;
  transparency: boolean;
  readonly visitedForms: Set<string>;
}

const MAX_FORM_DEPTH = 12;

function scanContent(state: ScanState, bytes: Uint8Array, resources: PDFDict | undefined, baseCtm: Matrix, depth: number): void {
  const { doc } = state;
  let ctm = baseCtm;
  const stack: Matrix[] = [];
  let fillFamily: ColorFamily = 'gray';
  let strokeFamily: ColorFamily = 'gray';

  const fonts = dictOf(doc, resources?.get(N('Font')));
  if (fonts) {
    for (const [key, ref] of fonts.entries()) {
      const id = ref instanceof PDFRef ? ref.toString() : `${depth}:${key.decodeText()}`;
      const font = dictOf(doc, ref);
      if (font && !state.fonts.has(id)) state.fonts.set(id, fontInfo(doc, font));
    }
  }

  for (const op of lexContent(bytes)) {
    const o = op.operands;
    switch (op.op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? baseCtm;
        break;
      case 'cm':
        if (o.length === 6) ctm = multiply([num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])], ctm);
        break;
      case 'rg':
      case 'RG':
        state.colorUse.rgb++;
        break;
      case 'k':
      case 'K':
        state.colorUse.cmyk++;
        break;
      case 'g':
      case 'G':
        state.colorUse.gray++;
        break;
      case 'cs':
        fillFamily = familyOfColorSpace(doc, N(opName(o[0]) ?? ''), resources);
        break;
      case 'CS':
        strokeFamily = familyOfColorSpace(doc, N(opName(o[0]) ?? ''), resources);
        break;
      case 'sc':
      case 'scn':
        state.colorUse[fillFamily]++;
        break;
      case 'SC':
      case 'SCN':
        state.colorUse[strokeFamily]++;
        break;
      case 'sh': {
        const shading = dictOf(doc, dictOf(doc, resources?.get(N('Shading')))?.get(N(opName(o[0]) ?? '')));
        state.colorUse[familyOfColorSpace(doc, shading?.get(N('ColorSpace')), resources)]++;
        break;
      }
      case 'gs': {
        const gs = dictOf(doc, dictOf(doc, resources?.get(N('ExtGState')))?.get(N(opName(o[0]) ?? '')));
        if (gs && extGStateHasTransparency(doc, gs)) state.transparency = true;
        break;
      }
      case 'Do':
        doXObject(state, opName(o[0]) ?? '', resources, ctm, depth);
        break;
      case 'BI': {
        const p = op.inlineImage!;
        const w = num(p.get('W') ?? p.get('Width'));
        const h = num(p.get('H') ?? p.get('Height'));
        const mask = p.get('IM') ?? p.get('ImageMask');
        addImage(state, 'インライン画像', w, h, ctm, familyOfInlineColorSpace(doc, p.get('CS') ?? p.get('ColorSpace'), resources), mask?.type === 'bool' && mask.value);
        break;
      }
    }
  }
}

function doXObject(state: ScanState, xName: string, resources: PDFDict | undefined, ctm: Matrix, depth: number): void {
  const { doc } = state;
  const ref = dictOf(doc, resources?.get(N('XObject')))?.get(N(xName));
  const xobj = resolve(doc, ref);
  if (!(xobj instanceof PDFStream)) return;
  const dict = xobj.dict;
  const subtype = nameOf(doc, dict.get(N('Subtype')));
  if (subtype === 'Image') {
    const isMask = resolve(doc, dict.get(N('ImageMask'))) === PDFBool.True;
    if (dict.has(N('SMask')) || dict.has(N('Mask'))) state.transparency ||= dict.has(N('SMask'));
    addImage(
      state,
      xName,
      numberOf(doc, dict.get(N('Width'))) ?? 0,
      numberOf(doc, dict.get(N('Height'))) ?? 0,
      ctm,
      isMask ? 'other' : familyOfColorSpace(doc, dict.get(N('ColorSpace')), resources),
      isMask,
      xobj instanceof PDFRawStream ? xobj.contents.length : undefined,
    );
  } else if (subtype === 'Form') {
    const id = ref instanceof PDFRef ? ref.toString() : xName;
    // 同じフォームが入れ子で自分自身を参照していたら打ち切る(循環参照対策)
    if (depth >= MAX_FORM_DEPTH || state.visitedForms.has(id)) return;
    // 透明グループ(/Group /S /Transparency)は Office の出力に常に付くことがあるため、透明効果の判定には使わない
    const m = resolve(doc, dict.get(N('Matrix')));
    const matrix: Matrix =
      m instanceof PDFArray && m.size() === 6
        ? (m.asArray().map((v) => numberOf(doc, v) ?? 0) as unknown as Matrix)
        : IDENTITY;
    const formResources = dictOf(doc, dict.get(N('Resources'))) ?? resources;
    state.visitedForms.add(id);
    try {
      scanContent(state, streamBytes(xobj), formResources, multiply(matrix, ctm), depth + 1);
    } catch {
      // 読めないフォームは飛ばす(チェック全体は止めない)
    }
    state.visitedForms.delete(id);
  }
}

function addImage(
  state: ScanState,
  imageName: string,
  w: number,
  h: number,
  ctm: Matrix,
  color: ColorFamily,
  isMask: boolean,
  encodedBytes?: number,
): void {
  const size = unitSquareSize(ctm);
  const dpiX = size.width > 0 ? w / (size.width / 72) : 0;
  const dpiY = size.height > 0 ? h / (size.height / 72) : 0;
  state.images.push({
    name: imageName,
    pixelWidth: w,
    pixelHeight: h,
    bounds: unitSquareBounds(ctm),
    dpi: Math.min(dpiX, dpiY),
    color,
    isMask,
    encodedBytes,
  });
  if (!isMask && color !== 'other') state.colorUse[color]++;
}

// ---------- ページ ----------

function boxOf(doc: PDFDocument, page: PDFPage, key: string): Rect | undefined {
  const v = resolve(doc, page.node.get(N(key)));
  if (!(v instanceof PDFArray) || v.size() !== 4) return undefined;
  const [a, b, c, d] = v.asArray().map((x) => numberOf(doc, x) ?? 0);
  return rect(a, b, c, d);
}

function toRect(b: { x: number; y: number; width: number; height: number }): Rect {
  return rect(b.x, b.y, b.x + b.width, b.y + b.height);
}

function annotationCounts(doc: PDFDocument, page: PDFPage): PageStructure['annotations'] {
  const annots = resolve(doc, page.node.get(N('Annots')));
  const counts = { links: 0, widgets: 0, others: 0 };
  if (!(annots instanceof PDFArray)) return counts;
  for (const a of annots.asArray()) {
    const subtype = nameOf(doc, dictOf(doc, a)?.get(N('Subtype')));
    if (subtype === 'Link') counts.links++;
    else if (subtype === 'Widget') counts.widgets++;
    else if (subtype !== 'Popup') counts.others++;
  }
  return counts;
}

export function scanPage(doc: PDFDocument, page: PDFPage, index: number): PageStructure {
  const state: ScanState = {
    doc,
    images: [],
    colorUse: { rgb: 0, cmyk: 0, gray: 0, spot: 0, other: 0 },
    fonts: new Map(),
    transparency: false,
    visitedForms: new Set(),
  };
  const resources = dictOf(doc, page.node.Resources());
  try {
    scanContent(state, pageContentBytes(doc, page), resources, IDENTITY, 0);
  } catch {
    // コンテンツが読めないページは、構造の情報だけで判定する
  }
  const mediaBox = toRect(page.getMediaBox());
  return {
    index,
    mediaBox,
    cropBox: boxOf(doc, page, 'CropBox') ?? mediaBox,
    trimBox: boxOf(doc, page, 'TrimBox'),
    bleedBox: boxOf(doc, page, 'BleedBox'),
    rotation: ((page.getRotation().angle % 360) + 360) % 360,
    fonts: [...state.fonts.values()],
    annotations: annotationCounts(doc, page),
    images: state.images,
    colorUse: state.colorUse,
    transparency: state.transparency,
  };
}

export function scanStructure(doc: PDFDocument): PageStructure[] {
  return doc.getPages().map((page, i) => scanPage(doc, page, i));
}
