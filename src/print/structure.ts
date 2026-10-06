// PDF の構造から、入稿チェックに必要な事実を取り出す(pdf-lib + 自前のコンテンツ解析)。
// ページの寸法・フォントの埋め込み・画像の配置と実効解像度・色の種類・透明効果・注釈に加え、
// 印刷で問題になりやすい描画(細い線・塗りだけの線・白のオーバープリント・小さな文字・リッチブラック・総インキ量・
// レジストレーション・非表示のレイヤー)を、場所(範囲)つきで記録する(PaintNote)。
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
import { DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, initialColor, PROCESS_COLORANTS, resolveColorSpace, type ColorFamily, type ColorSpaceInfo } from '../pdf/colorspace.ts';
import { extGStateReader } from '../pdf/extgstate.ts';
import { loadFontForEdit, type FontForEdit } from '../pdf/fonts.ts';
import { lexContent, name as opName, num, type ContentOp, type Operand } from '../pdf/lexer.ts';
import { applyToPoint, IDENTITY, mmToPt, multiply, rect, transformRect, unitSquareBounds, unitSquareSize, type Matrix, type Rect } from './geometry.ts';
import {
  INK_LIMIT_PERCENT,
  MAX_NOTES_PER_KIND,
  RICH_BLACK_MIN_CMY,
  RICH_BLACK_MIN_K,
  RICH_BLACK_TEXT_MAX_PT,
  SMALL_TEXT_PT,
  THIN_LINE_MM,
} from './thresholds.ts';

export type { ColorFamily };

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

/**
 * 印刷で問題になりやすい描画の種類
 * - zero-width-line: 線幅 0 の線 / thin-line: 細すぎる線(塗りの細い長方形を含む)
 * - fill-only-line: 面積のない形を塗りだけで描いたもの(印刷されない線)
 * - white-overprint: 白のオーバープリント(印刷されない)
 * - small-text: 小さすぎる文字 / rich-black-text: 小さな文字のリッチブラック
 * - ink-over: 総インキ量の超過 / registration: レジストレーション(トンボ用の色)
 * - hidden-layer: 非表示のレイヤーの中の描画
 * - unembedded-font: 埋め込まれていないフォントの文字 / transparent: 透明効果を使った描画
 */
export type PaintNoteKind =
  | 'zero-width-line'
  | 'thin-line'
  | 'fill-only-line'
  | 'white-overprint'
  | 'small-text'
  | 'rich-black-text'
  | 'ink-over'
  | 'registration'
  | 'hidden-layer'
  | 'unembedded-font'
  | 'transparent';

export interface PaintNote {
  readonly kind: PaintNoteKind;
  /** 描画の範囲(pt、ページ座標) */
  readonly bounds: Rect;
  /** 線幅(mm)・文字の大きさ(pt)・総インキ量(%)など */
  readonly value?: number;
  /** 文字の内容・フォント名など */
  readonly label?: string;
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
  /** 不透明度 0(完全に透明)の指定が使われている。Office が検索用の「見えない文字」に使うことがある */
  readonly fullyTransparent: boolean;
  /** 印刷で問題になりやすい描画(場所つき) */
  readonly notes: readonly PaintNote[];
  /** 使われている特色の名前(レジストレーションを除く) */
  readonly spotColors: readonly string[];
  /**
   * RGB(と Lab)の色で描いた範囲。くすみ警告はこの範囲だけを調べる(CMYK の色はインキの指定そのもので、
   * 変換でくすむことはないため)。範囲を特定できない描画(グラデーションなど)があれば 'all'
   */
  readonly rgbAreas: readonly Rect[] | 'all';
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

/** インライン画像の色空間(省略形あり)の分類 */
function familyOfInlineColorSpace(doc: PDFDocument, cs: Operand | undefined, resources: PDFDict | undefined): ColorFamily {
  if (!cs) return 'other';
  if (cs.type === 'name') return resolveColorSpace(doc, N(cs.value), resources).family;
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

// ---------- 色の値 ----------

interface Color {
  readonly space: ColorSpaceInfo;
  readonly comps: readonly number[];
}

const BLACK: Color = { space: DEVICE_GRAY, comps: [0] };

/** 印刷されない色(白・インキなし) */
function isWhite(c: Color): boolean {
  switch (c.space.kind) {
    case 'gray':
      return c.comps[0] >= 0.999;
    case 'rgb':
      return c.comps.length === 3 && c.comps.every((v) => v >= 0.999);
    case 'cmyk':
      return c.comps.length === 4 && c.comps.every((v) => v <= 0.001);
    case 'separation':
    case 'devicen':
      return !isRegistration(c) && c.comps.length > 0 && c.comps.every((v) => v <= 0.001);
    default:
      return false;
  }
}

function isRegistration(c: Color): boolean {
  return c.space.kind === 'separation' && c.space.names?.[0] === 'All' && (c.comps[0] ?? 1) > 0.001;
}

function cmykOf(c: Color): readonly number[] | undefined {
  return c.space.kind === 'cmyk' && c.comps.length === 4 ? c.comps : undefined;
}

function isRichBlack(c: Color): boolean {
  const k = cmykOf(c);
  return !!k && k[3] >= RICH_BLACK_MIN_K && k[0] + k[1] + k[2] >= RICH_BLACK_MIN_CMY;
}

function inkPercent(c: Color): number | undefined {
  const k = cmykOf(c);
  return k ? Math.round(k.reduce((s, v) => s + v, 0) * 100) : undefined;
}

// ---------- コンテンツの解析 ----------

interface ScanState {
  readonly doc: PDFDocument;
  readonly images: ImagePlacement[];
  readonly colorUse: Record<ColorFamily, number>;
  readonly fonts: Map<string, FontInfo>;
  transparency: boolean;
  fullyTransparent: boolean;
  readonly visitedForms: Set<string>;
  readonly notes: PaintNote[];
  readonly noteCounts: Map<PaintNoteKind, number>;
  readonly spotColors: Set<string>;
  /** 既定で非表示のレイヤー(OCG)の参照 */
  readonly hiddenGroups: ReadonlySet<string>;
  readonly fontCache: Map<string, { edit?: FontForEdit; info: FontInfo }>;
  rgbAreas: Rect[] | 'all';
}

interface Gs {
  ctm: Matrix;
  fill: Color;
  stroke: Color;
  lineWidth: number;
  fillAlpha: number;
  strokeAlpha: number;
  softMask: boolean;
  blend: boolean;
  overprintFill: boolean;
  overprintStroke: boolean;
  font: { edit?: FontForEdit; info: FontInfo } | undefined;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  textMode: number;
}

const MAX_FORM_DEPTH = 12;
const PATH_PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
const STROKE_PAINT = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const FILL_MODES = new Set([0, 2, 4, 6]);
const STROKE_MODES = new Set([1, 2, 5, 6]);
const DESCENT = 0.15;
const ASCENT = 0.85;
const THIN_LINE_PT = mmToPt(THIN_LINE_MM);

/** RGB の範囲の数の上限(超えたらページ全体を調べる) */
const MAX_RGB_AREAS = 2000;

/** 印刷の色を RGB で指定しているか(Lab と、元が RGB の Indexed を含む) */
function isRgbSpace(space: ColorSpaceInfo): boolean {
  const s = space.kind === 'indexed' && space.base ? space.base : space;
  return s.kind === 'rgb' || s.kind === 'lab';
}

function addRgbArea(state: ScanState, bounds: Rect | 'all'): void {
  if (state.rgbAreas === 'all') return;
  if (bounds === 'all' || state.rgbAreas.length >= MAX_RGB_AREAS) state.rgbAreas = 'all';
  else state.rgbAreas.push(bounds);
}

function addNote(state: ScanState, note: PaintNote): void {
  const n = state.noteCounts.get(note.kind) ?? 0;
  if (n >= MAX_NOTES_PER_KIND) return;
  state.noteCounts.set(note.kind, n + 1);
  state.notes.push(note);
}

/** 行列の拡大率のうち小さい方(線幅の実効値に使う) */
function minScale(m: Matrix): number {
  const [a, b, c, d] = m;
  const t = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt(Math.max(0, (t - Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2));
}

function boundsOf(points: readonly [number, number][]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/** 閉じた多角形の面積(点の並びから。曲線は制御点で近似) */
function polygonArea(points: readonly [number, number][]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

function scanContent(state: ScanState, bytes: Uint8Array, resources: PDFDict | undefined, baseCtm: Matrix, depth: number, hiddenAtStart: boolean): void {
  const { doc } = state;
  const gsReader = extGStateReader(resources);
  let gs: Gs = {
    ctm: baseCtm,
    fill: BLACK,
    stroke: BLACK,
    lineWidth: 1,
    fillAlpha: 1,
    strokeAlpha: 1,
    softMask: false,
    blend: false,
    overprintFill: false,
    overprintStroke: false,
    font: undefined,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    textMode: 0,
  };
  const stack: Gs[] = [];
  // マーク(BDC 〜 EMC)ごとの、非表示のレイヤーの中か
  const marked: boolean[] = [];
  const hidden = () => hiddenAtStart || marked[marked.length - 1] === true;

  const fontsDict = dictOf(doc, resources?.get(N('Font')));
  const fontFor = (resName: string) => {
    const ref = fontsDict?.get(N(resName));
    const id = ref instanceof PDFRef ? ref.toString() : `${depth}:${resName}`;
    let cached = state.fontCache.get(id);
    if (!cached) {
      const dict = dictOf(doc, ref);
      if (!dict) return undefined;
      let edit: FontForEdit | undefined;
      try {
        edit = loadFontForEdit(doc, resName, ref);
      } catch {
        edit = undefined; // 字幅が読めないフォントは、文字の範囲を目安で求める
      }
      cached = { edit, info: fontInfo(doc, dict) };
      state.fontCache.set(id, cached);
      state.fonts.set(id, cached.info);
    }
    return cached;
  };
  // 資源にあるフォントはすべて「使われているフォント」として数える(従来どおり)
  if (fontsDict) for (const [key] of fontsDict.entries()) fontFor(key.decodeText());

  const spaceOf = (name: string): ColorSpaceInfo => resolveColorSpace(doc, N(name), resources);
  const useColor = (c: Color) => {
    if (c.space.kind === 'separation' || c.space.kind === 'devicen') {
      for (const n of c.space.names ?? []) if (n !== 'All' && !PROCESS_COLORANTS.has(n)) state.spotColors.add(n);
    }
  };

  // パス
  let subpaths: [number, number][][] = [];
  let current: [number, number][] = [];
  let rectsOnly = true;
  let rectThickness = Infinity;
  const point = (x: number, y: number) => current.push(applyToPoint(gs.ctm, x, y));
  const resetPath = () => {
    subpaths = [];
    current = [];
    rectsOnly = true;
    rectThickness = Infinity;
  };
  const closeSubpath = () => {
    if (current.length > 0) subpaths.push(current);
    current = [];
  };

  /** 塗り・線の描画の共通の確認 */
  const checkPaint = (bounds: Rect, fill: boolean, stroke: boolean) => {
    if (hidden()) addNote(state, { kind: 'hidden-layer', bounds });
    if ((fill && gs.fillAlpha > 0 && isRgbSpace(gs.fill.space)) || (stroke && gs.strokeAlpha > 0 && isRgbSpace(gs.stroke.space))) addRgbArea(state, bounds);
    if (fill && gs.fillAlpha > 0) {
      useColor(gs.fill);
      if (gs.overprintFill && isWhite(gs.fill)) addNote(state, { kind: 'white-overprint', bounds });
      if (isRegistration(gs.fill)) addNote(state, { kind: 'registration', bounds });
      const ink = inkPercent(gs.fill);
      if (ink !== undefined && ink > INK_LIMIT_PERCENT) addNote(state, { kind: 'ink-over', bounds, value: ink });
    }
    if (stroke && gs.strokeAlpha > 0) {
      useColor(gs.stroke);
      if (gs.overprintStroke && isWhite(gs.stroke)) addNote(state, { kind: 'white-overprint', bounds });
      if (isRegistration(gs.stroke)) addNote(state, { kind: 'registration', bounds });
      const ink = inkPercent(gs.stroke);
      if (ink !== undefined && ink > INK_LIMIT_PERCENT) addNote(state, { kind: 'ink-over', bounds, value: ink });
    }
    if ((fill && gs.fillAlpha < 1) || (stroke && gs.strokeAlpha < 1) || gs.softMask || gs.blend) addNote(state, { kind: 'transparent', bounds });
  };

  const paintPath = (op: string) => {
    closeSubpath();
    const points = subpaths.flat();
    if (points.length === 0) return;
    const stroke = STROKE_PAINT.has(op);
    const fill = op !== 'S' && op !== 's';
    const half = stroke ? (gs.lineWidth * minScale(gs.ctm)) / 2 : 0;
    const box = boundsOf(points);
    const bounds = rect(box.x0 - half, box.y0 - half, box.x1 + half, box.y1 + half);
    checkPaint(bounds, fill, stroke);
    if (stroke && gs.strokeAlpha > 0 && !isWhite(gs.stroke)) {
      const width = gs.lineWidth * minScale(gs.ctm);
      if (gs.lineWidth === 0) addNote(state, { kind: 'zero-width-line', bounds, value: 0 });
      else if (width < THIN_LINE_PT) addNote(state, { kind: 'thin-line', bounds, value: (width * 25.4) / 72 });
    } else if (fill && gs.fillAlpha > 0 && !isWhite(gs.fill)) {
      const diag = Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
      if (rectsOnly && rectThickness < THIN_LINE_PT && rectThickness > 0) {
        addNote(state, { kind: 'thin-line', bounds, value: (rectThickness * 25.4) / 72 });
      } else if (diag > 1) {
        const area = subpaths.reduce((s, sp) => s + (sp.length >= 3 ? polygonArea(sp) : 0), 0);
        // 面積がほとんどない(線の形を塗りだけで描いた)もの
        if (area < diag * 0.01) addNote(state, { kind: 'fill-only-line', bounds });
      }
    }
  };

  // 文字
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const showText = (op: ContentOp) => {
    const font = gs.font;
    const size = gs.fontSize;
    const edit = font?.edit;
    const items =
      op.op === 'TJ' && op.operands[0]?.type === 'array'
        ? op.operands[0].items
        : [op.operands[op.op === '"' ? 2 : 0]].filter((o) => o !== undefined);
    let x = 0;
    let text = '';
    const codeBytes = edit?.codeBytes ?? 1;
    for (const item of items) {
      if (item.type === 'number') {
        x -= (item.value / 1000) * size * gs.hScale;
        continue;
      }
      if (item.type !== 'string') continue;
      for (let i = 0; i + codeBytes <= item.bytes.length; i += codeBytes) {
        const code = codeBytes === 2 ? (item.bytes[i] << 8) | item.bytes[i + 1] : item.bytes[i];
        const w = (edit ? edit.widthOf(code) / 1000 : 0) || 0.5;
        const space = codeBytes === 1 && code === 32 ? gs.wordSpacing : 0;
        x += (w * size + gs.charSpacing + space) * gs.hScale;
        text += edit?.toUnicode.get(code) ?? '';
      }
    }
    const m = multiply(tm, gs.ctm);
    const bounds = transformRect(m, rect(0, gs.rise - DESCENT * size, x, gs.rise + ASCENT * size));
    tm = multiply([1, 0, 0, 1, x, 0], tm);
    const fillVisible = FILL_MODES.has(gs.textMode) && gs.fillAlpha > 0;
    const strokeVisible = STROKE_MODES.has(gs.textMode) && gs.strokeAlpha > 0;
    if (!fillVisible && !strokeVisible) return;
    checkPaint(bounds, fillVisible, strokeVisible);
    const label = text.trim().slice(0, 16);
    if (font && !font.info.embedded) addNote(state, { kind: 'unembedded-font', bounds, label: font.info.name });
    const effective = size * Math.hypot(m[2], m[3]);
    if (effective > 0 && effective < SMALL_TEXT_PT && label !== '') addNote(state, { kind: 'small-text', bounds, value: effective, label });
    if (fillVisible && effective < RICH_BLACK_TEXT_MAX_PT && isRichBlack(gs.fill) && label !== '') {
      addNote(state, { kind: 'rich-black-text', bounds, value: effective, label });
    }
  };

  const setColor = (target: 'fill' | 'stroke', space: ColorSpaceInfo, operands: readonly Operand[]) => {
    const comps = operands.filter((o) => o.type === 'number').map((o) => num(o));
    const color: Color = { space, comps: comps.length > 0 ? comps : initialColor(space) };
    if (target === 'fill') gs.fill = color;
    else gs.stroke = color;
  };

  for (const op of lexContent(bytes)) {
    const o = op.operands;
    switch (op.op) {
      case 'q':
        stack.push({ ...gs });
        break;
      case 'Q':
        gs = stack.pop() ?? gs;
        break;
      case 'cm':
        if (o.length === 6) gs.ctm = multiply([num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = num(o[0]);
        break;
      // ---- 色 ----
      case 'rg':
      case 'RG':
        state.colorUse.rgb++;
        setColor(op.op === 'rg' ? 'fill' : 'stroke', DEVICE_RGB, o);
        break;
      case 'k':
      case 'K':
        state.colorUse.cmyk++;
        setColor(op.op === 'k' ? 'fill' : 'stroke', DEVICE_CMYK, o);
        break;
      case 'g':
      case 'G':
        state.colorUse.gray++;
        setColor(op.op === 'g' ? 'fill' : 'stroke', DEVICE_GRAY, o);
        break;
      case 'cs': {
        const space = spaceOf(opName(o[0]) ?? '');
        gs.fill = { space, comps: initialColor(space) };
        break;
      }
      case 'CS': {
        const space = spaceOf(opName(o[0]) ?? '');
        gs.stroke = { space, comps: initialColor(space) };
        break;
      }
      case 'sc':
      case 'scn':
        state.colorUse[gs.fill.space.family]++;
        setColor('fill', gs.fill.space, o);
        break;
      case 'SC':
      case 'SCN':
        state.colorUse[gs.stroke.space.family]++;
        setColor('stroke', gs.stroke.space, o);
        break;
      case 'sh': {
        const shading = dictOf(doc, dictOf(doc, resources?.get(N('Shading')))?.get(N(opName(o[0]) ?? '')));
        const space = resolveColorSpace(doc, shading?.get(N('ColorSpace')), resources);
        state.colorUse[space.family]++;
        useColor({ space, comps: [] });
        if (isRgbSpace(space)) addRgbArea(state, 'all'); // グラデーションの範囲はクリップ次第で特定しにくい
        if (hidden()) addNote(state, { kind: 'hidden-layer', bounds: transformRect(gs.ctm, rect(0, 0, 0, 0)) });
        break;
      }
      case 'gs': {
        const name = opName(o[0]) ?? '';
        const gsDict = dictOf(doc, dictOf(doc, resources?.get(N('ExtGState')))?.get(N(name)));
        if (gsDict && extGStateHasTransparency(doc, gsDict)) state.transparency = true;
        if (gsDict && (numberOf(doc, gsDict.get(N('ca'))) === 0 || numberOf(doc, gsDict.get(N('CA'))) === 0)) state.fullyTransparent = true;
        const info = gsReader(name);
        if (info) {
          if (info.fillAlpha !== undefined) gs.fillAlpha = info.fillAlpha;
          if (info.strokeAlpha !== undefined) gs.strokeAlpha = info.strokeAlpha;
          if (info.softMask !== undefined) gs.softMask = info.softMask;
          if (info.blend !== undefined) gs.blend = info.blend;
          if (info.overprintFill !== undefined) gs.overprintFill = info.overprintFill;
          if (info.overprintStroke !== undefined) gs.overprintStroke = info.overprintStroke;
          if (info.lineWidth !== undefined) gs.lineWidth = info.lineWidth;
        }
        break;
      }
      // ---- マーク(非表示のレイヤー) ----
      case 'BDC': {
        let hide = hidden();
        if (opName(o[0]) === 'OC') {
          const props = o[1];
          const ref = props?.type === 'name' ? dictOf(doc, resources?.get(N('Properties')))?.get(N(props.value)) : undefined;
          if (ref && isHiddenGroup(doc, ref, state.hiddenGroups)) hide = true;
        }
        marked.push(hide);
        break;
      }
      case 'BMC':
        marked.push(hidden());
        break;
      case 'EMC':
        marked.pop();
        break;
      // ---- パス ----
      case 'm':
        closeSubpath();
        point(num(o[0]), num(o[1]));
        rectsOnly = false;
        break;
      case 'l':
        point(num(o[0]), num(o[1]));
        rectsOnly = false;
        break;
      case 'c':
        point(num(o[0]), num(o[1]));
        point(num(o[2]), num(o[3]));
        point(num(o[4]), num(o[5]));
        rectsOnly = false;
        break;
      case 'v':
      case 'y':
        point(num(o[0]), num(o[1]));
        point(num(o[2]), num(o[3]));
        rectsOnly = false;
        break;
      case 'h':
        closeSubpath();
        break;
      case 're': {
        closeSubpath();
        const [x, y, w, h] = o.map(num);
        point(x, y);
        point(x + w, y);
        point(x + w, y + h);
        point(x, y + h);
        closeSubpath();
        // 長方形の短い方の辺の長さ(CTM で写した後)
        const [a, b, c, d] = gs.ctm;
        rectThickness = Math.min(rectThickness, Math.min(Math.abs(w) * Math.hypot(a, b), Math.abs(h) * Math.hypot(c, d)));
        break;
      }
      case 'n':
        resetPath();
        break;
      // ---- 文字 ----
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf':
        gs.font = fontFor(opName(o[0]) ?? '');
        gs.fontSize = num(o[1]);
        break;
      case 'Tc':
        gs.charSpacing = num(o[0]);
        break;
      case 'Tw':
        gs.wordSpacing = num(o[0]);
        break;
      case 'Tz':
        gs.hScale = num(o[0]) / 100;
        break;
      case 'TL':
        gs.leading = num(o[0]);
        break;
      case 'Ts':
        gs.rise = num(o[0]);
        break;
      case 'Tr':
        gs.textMode = num(o[0]);
        break;
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case 'TD':
        gs.leading = -num(o[1]);
        tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])];
        tm = tlm;
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        break;
      case "'":
      case '"':
        if (op.op === '"') {
          gs.wordSpacing = num(o[0]);
          gs.charSpacing = num(o[1]);
        }
        tlm = multiply([1, 0, 0, 1, 0, -gs.leading], tlm);
        tm = tlm;
        showText(op);
        break;
      case 'Tj':
      case 'TJ':
        showText(op);
        break;
      // ---- 画像・フォーム ----
      case 'Do':
        doXObject(state, opName(o[0]) ?? '', resources, gs, depth, hidden());
        break;
      case 'BI': {
        const p = op.inlineImage!;
        const w = num(p.get('W') ?? p.get('Width'));
        const h = num(p.get('H') ?? p.get('Height'));
        const mask = p.get('IM') ?? p.get('ImageMask');
        const inlineFamily = familyOfInlineColorSpace(doc, p.get('CS') ?? p.get('ColorSpace'), resources);
        addImage(state, 'インライン画像', w, h, gs.ctm, inlineFamily, mask?.type === 'bool' && mask.value);
        if (inlineFamily === 'rgb') addRgbArea(state, unitSquareBounds(gs.ctm));
        if (hidden()) addNote(state, { kind: 'hidden-layer', bounds: unitSquareBounds(gs.ctm) });
        break;
      }
      default:
        if (PATH_PAINT.has(op.op)) {
          paintPath(op.op);
          resetPath();
        }
    }
  }
}

/** 既定で非表示のレイヤー(OCG)か、そのレイヤーで表示が決まる OCMD か */
function isHiddenGroup(doc: PDFDocument, ref: PDFObject, hiddenGroups: ReadonlySet<string>): boolean {
  if (hiddenGroups.size === 0) return false;
  if (ref instanceof PDFRef && hiddenGroups.has(ref.toString())) return true;
  const dict = dictOf(doc, ref);
  if (nameOf(doc, dict?.get(N('Type'))) !== 'OCMD') return false;
  // OCMD(既定の AnyOn): 含まれるレイヤーがすべて非表示なら非表示
  const ocgs = resolve(doc, dict?.get(N('OCGs')));
  const refs = ocgs instanceof PDFArray ? ocgs.asArray() : ocgs ? [dict!.get(N('OCGs'))!] : [];
  return refs.length > 0 && refs.every((r) => r instanceof PDFRef && hiddenGroups.has(r.toString()));
}

function doXObject(state: ScanState, xName: string, resources: PDFDict | undefined, gs: Gs, depth: number, hidden: boolean): void {
  const { doc } = state;
  const ref = dictOf(doc, resources?.get(N('XObject')))?.get(N(xName));
  const xobj = resolve(doc, ref);
  if (!(xobj instanceof PDFStream)) return;
  const dict = xobj.dict;
  const oc = dict.get(N('OC'));
  const hide = hidden || (oc !== undefined && isHiddenGroup(doc, oc, state.hiddenGroups));
  const subtype = nameOf(doc, dict.get(N('Subtype')));
  if (subtype === 'Image') {
    const isMask = resolve(doc, dict.get(N('ImageMask'))) === PDFBool.True;
    const bounds = unitSquareBounds(gs.ctm);
    if (dict.has(N('SMask'))) {
      state.transparency = true;
      addNote(state, { kind: 'transparent', bounds });
    } else if (gs.fillAlpha < 1 || gs.softMask || gs.blend) {
      addNote(state, { kind: 'transparent', bounds });
    }
    if (hide) addNote(state, { kind: 'hidden-layer', bounds });
    if (!isMask && isRgbSpace(resolveColorSpace(doc, dict.get(N('ColorSpace')), resources))) addRgbArea(state, bounds);
    addImage(
      state,
      xName,
      numberOf(doc, dict.get(N('Width'))) ?? 0,
      numberOf(doc, dict.get(N('Height'))) ?? 0,
      gs.ctm,
      isMask ? 'other' : resolveColorSpace(doc, dict.get(N('ColorSpace')), resources).family,
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
      m instanceof PDFArray && m.size() === 6 ? (m.asArray().map((v) => numberOf(doc, v) ?? 0) as unknown as Matrix) : IDENTITY;
    const formResources = dictOf(doc, dict.get(N('Resources'))) ?? resources;
    state.visitedForms.add(id);
    try {
      scanContent(state, streamBytes(xobj), formResources, multiply(matrix, gs.ctm), depth + 1, hide);
    } catch {
      // 読めないフォームは飛ばす(チェック全体は止めない)
    }
    state.visitedForms.delete(id);
  }
}

function addImage(state: ScanState, imageName: string, w: number, h: number, ctm: Matrix, color: ColorFamily, isMask: boolean, encodedBytes?: number): void {
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

/** 文書の既定の設定で非表示のレイヤー(OCG)の参照 */
export function hiddenOptionalContent(doc: PDFDocument): Set<string> {
  const props = dictOf(doc, doc.catalog.get(N('OCProperties')));
  const d = dictOf(doc, props?.get(N('D')));
  const off = resolve(doc, d?.get(N('OFF')));
  const set = new Set<string>();
  if (off instanceof PDFArray) for (const r of off.asArray()) if (r instanceof PDFRef) set.add(r.toString());
  return set;
}

export function scanPage(doc: PDFDocument, page: PDFPage, index: number, hiddenGroups: ReadonlySet<string> = hiddenOptionalContent(doc)): PageStructure {
  const state: ScanState = {
    doc,
    images: [],
    colorUse: { rgb: 0, cmyk: 0, gray: 0, spot: 0, other: 0 },
    fonts: new Map(),
    transparency: false,
    fullyTransparent: false,
    visitedForms: new Set(),
    notes: [],
    noteCounts: new Map(),
    spotColors: new Set(),
    hiddenGroups,
    fontCache: new Map(),
    rgbAreas: [],
  };
  const resources = dictOf(doc, page.node.Resources());
  try {
    scanContent(state, pageContentBytes(doc, page), resources, IDENTITY, 0, false);
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
    fullyTransparent: state.fullyTransparent,
    notes: state.notes,
    spotColors: [...state.spotColors].sort(),
    rgbAreas: state.rgbAreas,
  };
}

export function scanStructure(doc: PDFDocument): PageStructure[] {
  const hidden = hiddenOptionalContent(doc);
  return doc.getPages().map((page, i) => scanPage(doc, page, i, hidden));
}
