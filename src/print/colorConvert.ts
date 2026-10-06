// 色の調整(D-035): 入稿用 PDF の色を、RGB のまま・黒だけ K100・CMYK に変換、から選んで書き換える。
// あわせて、白のオーバープリントを解除できる(D-033)。
//
// - rgb: 色は変えない(白のオーバープリントの解除だけ行える)
// - k100: 文字・線・図形の無彩色の RGB(黒・グレー)を K だけにする。CMYK のリッチブラックの文字を K100 にする。ほかの色と画像はそのまま
// - cmyk: すべての色を CMYK にする(Japan Color 2011 Coated の変換表)。文字・線・図形の無彩色は K だけ、
//   画像は変換表どおり(写真の黒は 4 色)。グラデーションは関数を標本にして変換し、特色は代替の色を経由して変換する。
//   透明グループの色空間も CMYK にする
// 変換できないもの(JPEG 2000 の画像・インライン画像・頂点に色を持つメッシュなど)はページごとに理由を返す。
// 呼び出し側は、そのページを焼き込み(文字以外を画像にする)にしてから変換し直す。
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { DEVICE_CMYK, DEVICE_GRAY, DEVICE_RGB, initialColor, resolveColorSpace, type ColorSpaceInfo } from '../pdf/colorspace.ts';
import { extGStateReader } from '../pdf/extgstate.ts';
import { loadFunction, type PdfFunction } from '../pdf/functions.ts';
import { lexContent, name as opName, num } from '../pdf/lexer.ts';
import { serializeOp, serializeOperand, spliceAll, type Splice } from '../pdf/serialize.ts';
import { convertRgbPixels, grayToCmyk, isRichBlackCmyk, labToCmyk, rgbToCmyk, vectorRgbToCmyk, type Cmyk } from './cmyk.ts';
import { IDENTITY, multiply, type Matrix } from './geometry.ts';
import { pageContentBytes, streamBytes } from './structure.ts';
import { RICH_BLACK_MIN_CMY, RICH_BLACK_MIN_K, RICH_BLACK_TEXT_MAX_PT } from './thresholds.ts';

export type ColorMode = 'rgb' | 'k100' | 'cmyk';

/** JPEG を画素にする(ブラウザで行う。テストでは渡さない) */
export type JpegDecoder = (jpeg: Uint8Array) => Promise<{ data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 3 | 4 }>;

export interface ColorOptions {
  readonly mode: ColorMode;
  readonly fixWhiteOverprint: boolean;
  readonly targetPages?: ReadonlySet<number> | 'all';
  readonly decodeJpeg?: JpegDecoder;
}

export interface ColorPageResult {
  readonly page: number;
  /** 変換した色の指定(文字・線・図形)の数 */
  readonly colors: number;
  readonly images: number;
  readonly shadings: number;
  /** K100 にしたリッチブラックの文字の数 */
  readonly richBlackText: number;
  /** 解除した白のオーバープリントの数 */
  readonly whiteOverprint: number;
  /** 変換できなかったもの(理由) */
  readonly unsupported: readonly string[];
}

export interface ColorResult {
  readonly bytes: Uint8Array;
  readonly pages: readonly ColorPageResult[];
}

const N = (s: string) => PDFName.of(s);
const SHOW = new Set(['Tj', 'TJ', "'", '"']);
const FILL_TEXT_MODES = new Set([0, 2, 4, 6]);

interface Stats {
  colors: number;
  images: number;
  shadings: number;
  richBlackText: number;
  whiteOverprint: number;
  unsupported: Set<string>;
}

interface ColorState {
  space: ColorSpaceInfo;
  /** cs で指定したときの色空間の名前(書き出し用) */
  spaceOperand?: string;
  comps: number[];
}

interface Gs {
  ctm: Matrix;
  fill: ColorState;
  stroke: ColorState;
  /** いま書き出してある塗りの色の命令(リッチブラックの文字の後に戻すため) */
  outFill: string;
  /** 最後に書き出した塗りの色が k(DeviceCMYK)か */
  outFillIsK: boolean;
  outStrokeIsK: boolean;
  opFill: boolean;
  opStroke: boolean;
  emittedOpFill: boolean;
  emittedOpStroke: boolean;
  fontSize: number;
  textMode: number;
}

const fmt = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
const cmykOp = (c: Cmyk, stroke: boolean) => `${c.map(fmt).join(' ')} ${stroke ? 'K' : 'k'}`;

function resolve(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}

function isWhite(c: ColorState): boolean {
  const v = c.comps;
  switch (c.space.kind) {
    case 'gray':
      return v[0] >= 0.999;
    case 'rgb':
      return v.length === 3 && v.every((x) => x >= 0.999);
    case 'cmyk':
      return v.length === 4 && v.every((x) => x <= 0.001);
    case 'separation':
    case 'devicen':
      return c.space.names?.[0] !== 'All' && v.length > 0 && v.every((x) => x <= 0.001);
    default:
      return false;
  }
}

class Converter {
  private readonly functions = new Map<PDFObject, PdfFunction | null>();
  private readonly palettes = new Map<PDFObject, Uint8Array | null>();
  /** 変換済みのオブジェクト(画像・フォーム・グラデーション・模様・Type3 の字形)の参照 */
  private readonly done = new Set<string>();
  /** 資源の辞書ごとの、オーバープリントを切り替える ExtGState の名前 */
  private readonly opStates = new Map<PDFDict, Map<string, string>>();

  constructor(
    readonly doc: PDFDocument,
    readonly options: ColorOptions,
  ) {}

  private fn(obj: PDFObject | undefined): PdfFunction | undefined {
    if (!obj) return undefined;
    const key = obj instanceof PDFRef ? (this.doc.context.lookup(obj) ?? obj) : obj;
    if (!this.functions.has(key)) this.functions.set(key, loadFunction(this.doc, obj) ?? null);
    return this.functions.get(key) ?? undefined;
  }

  private palette(space: ColorSpaceInfo): Uint8Array | undefined {
    const arr = space.obj instanceof PDFArray ? space.obj : undefined;
    const lookup = arr ? resolve(this.doc, arr.get(3)) : undefined;
    if (!lookup) return undefined;
    if (!this.palettes.has(lookup)) {
      let bytes: Uint8Array | null = null;
      if (lookup instanceof PDFString || lookup instanceof PDFHexString) bytes = lookup.asBytes();
      else if (lookup instanceof PDFStream) {
        try {
          bytes = streamBytes(lookup);
        } catch {
          bytes = null;
        }
      }
      this.palettes.set(lookup, bytes);
    }
    return this.palettes.get(lookup) ?? undefined;
  }

  /**
   * 色の値を、書き出す CMYK にする。変えない(そのまま残す)なら undefined。
   * vector: 文字・線・図形・グラデーションの色(無彩色は K だけ)
   */
  toCmyk(space: ColorSpaceInfo, comps: readonly number[], vector: boolean): Cmyk | undefined {
    const mode = this.options.mode;
    if (mode === 'rgb') return undefined;
    if (mode === 'k100') {
      if (space.kind !== 'rgb' || comps.length !== 3) return undefined;
      const [r, g, b] = comps;
      return Math.abs(r - g) <= 0.02 && Math.abs(g - b) <= 0.02 && Math.abs(r - b) <= 0.02 ? [0, 0, 0, 1 - (r + g + b) / 3] : undefined;
    }
    switch (space.kind) {
      case 'rgb':
        return vector ? vectorRgbToCmyk(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0) : rgbToCmyk(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0);
      case 'gray':
        return grayToCmyk(comps[0] ?? 0);
      case 'lab':
        return labToCmyk(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0, vector);
      case 'indexed': {
        const base = space.base;
        const table = this.palette(space);
        if (!base || !table) return undefined;
        const n = base.n;
        const i = Math.round(comps[0] ?? 0);
        const raw = Array.from({ length: n }, (_, k) => table[i * n + k] ?? 0);
        const baseComps = base.kind === 'lab' ? [raw[0] / 2.55, raw[1] - 128, raw[2] - 128] : raw.map((x) => x / 255);
        return base.kind === 'cmyk' ? (baseComps as Cmyk) : this.toCmyk(base, baseComps, vector);
      }
      case 'separation':
      case 'devicen': {
        if (space.names?.some((n) => n === 'All' || n === 'None')) return undefined; // レジストレーション(トンボ)は変えない
        const arr = space.obj instanceof PDFArray ? space.obj : undefined;
        const tint = this.fn(arr?.get(3));
        if (!tint || !space.base) return undefined;
        const alt = tint([...comps]);
        return space.base.kind === 'cmyk' ? (alt.slice(0, 4) as Cmyk) : this.toCmyk(space.base, alt, vector);
      }
      default:
        return undefined;
    }
  }

  /** そのまま残すと CMYK にならない色空間か(cmyk のときに変換の対象) */
  private needsConversion(space: ColorSpaceInfo): boolean {
    if (this.options.mode !== 'cmyk') return false;
    if (space.kind === 'separation' || space.kind === 'devicen') return !space.names?.some((n) => n === 'All' || n === 'None');
    return space.kind === 'rgb' || space.kind === 'lab' || (space.kind === 'indexed' && !!space.base && space.base.kind !== 'cmyk' && space.base.kind !== 'gray');
  }

  /** オーバープリントを指定どおりにする ExtGState の名前(資源の辞書に加える) */
  private opStateName(resources: PDFDict, stroke: boolean, fill: boolean): string {
    let names = this.opStates.get(resources);
    if (!names) {
      names = new Map();
      this.opStates.set(resources, names);
    }
    const key = `${stroke ? 1 : 0}${fill ? 1 : 0}`;
    let name = names.get(key);
    if (!name) {
      let dict = resolve(this.doc, resources.get(N('ExtGState')));
      if (!(dict instanceof PDFDict)) {
        dict = this.doc.context.obj({});
        resources.set(N('ExtGState'), dict);
      }
      const gsDict = dict as PDFDict;
      let i = 0;
      do name = `OPfix${key}_${i++}`;
      while (gsDict.has(N(name)));
      gsDict.set(N(name), this.doc.context.register(this.doc.context.obj({ Type: 'ExtGState', OP: stroke, op: fill })));
      names.set(key, name);
    }
    return name;
  }

  // ---------- コンテンツ ----------

  async rewrite(content: Uint8Array, resources: PDFDict, stats: Stats): Promise<Uint8Array | undefined> {
    const doc = this.doc;
    const ops = lexContent(content);
    const gsReader = extGStateReader(resources);
    const black: ColorState = { space: DEVICE_GRAY, comps: [0] };
    let gs: Gs = {
      ctm: IDENTITY,
      fill: black,
      stroke: black,
      outFill: '0 g',
      outFillIsK: false,
      outStrokeIsK: false,
      opFill: false,
      opStroke: false,
      emittedOpFill: false,
      emittedOpStroke: false,
      fontSize: 0,
      textMode: 0,
    };
    const stack: Gs[] = [];
    let tmLinear: Matrix = IDENTITY;
    const splices: Splice[] = [];
    const cmykMode = this.options.mode === 'cmyk';

    if (cmykMode) await this.convertPatterns(resources, stats);

    for (const op of ops) {
      const o = op.operands;
      const before: string[] = [];
      const after: string[] = [];
      let replace: string | undefined;

      /** 白のオーバープリントを解除する(白の間だけ、オーバープリントを切る) */
      const fixOverprint = () => {
        if (!this.options.fixWhiteOverprint) return;
        const fill = gs.opFill && !isWhite(gs.fill);
        const stroke = gs.opStroke && !isWhite(gs.stroke);
        if (fill === gs.emittedOpFill && stroke === gs.emittedOpStroke) return;
        if ((gs.opFill && !fill && gs.emittedOpFill) || (gs.opStroke && !stroke && gs.emittedOpStroke)) stats.whiteOverprint++;
        after.push(`/${this.opStateName(resources, stroke, fill)} gs`);
        gs.emittedOpFill = fill;
        gs.emittedOpStroke = stroke;
      };

      const setColor = (stroke: boolean, state: ColorState, original: string, isDeviceOp: boolean) => {
        const conv = this.toCmyk(state.space, state.comps, true);
        if (stroke) gs.stroke = state;
        else gs.fill = state;
        if (conv) {
          replace = cmykOp(conv, stroke);
          stats.colors++;
        } else if (!isDeviceOp && (stroke ? gs.outStrokeIsK : gs.outFillIsK) && state.spaceOperand && state.space.kind !== 'cmyk') {
          // 直前に K の命令で色空間を変えているので、元の色空間を指定し直す
          replace = `${state.spaceOperand} ${stroke ? 'CS' : 'cs'} ${original}`;
        }
        const out = replace ?? original;
        if (stroke) gs.outStrokeIsK = !!conv;
        else {
          gs.outFillIsK = !!conv;
          gs.outFill = conv ? out : state.spaceOperand && !isDeviceOp ? `${state.spaceOperand} cs ${original}` : original;
        }
        fixOverprint();
      };

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
        case 'gs': {
          const info = gsReader(opName(o[0]) ?? '');
          if (info?.overprintFill !== undefined) gs.opFill = gs.emittedOpFill = info.overprintFill;
          if (info?.overprintStroke !== undefined) gs.opStroke = gs.emittedOpStroke = info.overprintStroke;
          fixOverprint();
          break;
        }
        case 'g':
        case 'G':
          setColor(op.op === 'G', { space: DEVICE_GRAY, comps: [num(o[0])] }, serializeOp(op), true);
          break;
        case 'rg':
        case 'RG':
          setColor(op.op === 'RG', { space: DEVICE_RGB, comps: o.map(num) }, serializeOp(op), true);
          break;
        case 'k':
        case 'K':
          setColor(op.op === 'K', { space: DEVICE_CMYK, comps: o.map(num) }, serializeOp(op), true);
          break;
        case 'cs':
        case 'CS': {
          const stroke = op.op === 'CS';
          const space = resolveColorSpace(doc, N(opName(o[0]) ?? ''), resources);
          const state: ColorState = { space, spaceOperand: o[0] ? serializeOperand(o[0]) : undefined, comps: initialColor(space) };
          if (this.needsConversion(space)) {
            // 色空間を選んだ直後の色(初期値)を、CMYK で指定する
            setColor(stroke, state, serializeOp(op), false);
          } else {
            if (stroke) {
              gs.stroke = state;
              gs.outStrokeIsK = false;
            } else {
              gs.fill = state;
              gs.outFillIsK = false;
              gs.outFill = serializeOp(op);
            }
            fixOverprint();
          }
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const stroke = op.op === 'SC' || op.op === 'SCN';
          const current = stroke ? gs.stroke : gs.fill;
          const pattern = o.some((x) => x.type === 'name');
          if (pattern) {
            if (stroke) gs.stroke = { ...current, comps: [] };
            else gs.fill = { ...current, comps: [] };
            break;
          }
          setColor(stroke, { ...current, comps: o.map(num) }, serializeOp(op), false);
          break;
        }
        case 'BT':
          tmLinear = IDENTITY;
          break;
        case 'Tm':
          tmLinear = [num(o[0]), num(o[1]), num(o[2]), num(o[3]), 0, 0];
          break;
        case 'Tf':
          gs.fontSize = num(o[1]);
          if (cmykMode) await this.convertType3(opName(o[0]) ?? '', resources, stats);
          break;
        case 'Tr':
          gs.textMode = num(o[0]);
          break;
        case 'Do':
          if (cmykMode) await this.convertXObject(opName(o[0]) ?? '', resources, stats);
          break;
        case 'sh':
          if (cmykMode) this.convertShadingResource(opName(o[0]) ?? '', resources, stats);
          break;
        case 'BI': {
          if (!cmykMode) break;
          const p = op.inlineImage!;
          const csOperand = p.get('CS') ?? p.get('ColorSpace');
          const mask = p.get('IM') ?? p.get('ImageMask');
          if (mask?.type === 'bool' && mask.value) break;
          const csName = csOperand?.type === 'name' ? csOperand.value : undefined;
          const short: Record<string, ColorSpaceInfo> = { G: DEVICE_GRAY, RGB: DEVICE_RGB, CMYK: DEVICE_CMYK };
          const space = csName ? (short[csName] ?? resolveColorSpace(doc, N(csName), resources)) : undefined;
          if (!space || this.needsConversion(space) || space.kind === 'unknown') stats.unsupported.add('インライン画像');
          break;
        }
      }

      // リッチブラックの小さな文字は K100 にする(文字の後で元の色に戻す)
      if (SHOW.has(op.op) && this.options.mode !== 'rgb' && FILL_TEXT_MODES.has(gs.textMode)) {
        const out = gs.fill.space.kind === 'cmyk' ? gs.fill.comps : this.toCmyk(gs.fill.space, gs.fill.comps, true);
        const m = multiply(tmLinear, gs.ctm);
        const size = gs.fontSize * Math.hypot(m[2], m[3]);
        if (out && out.length === 4 && size < RICH_BLACK_TEXT_MAX_PT && isRichBlackCmyk(out, RICH_BLACK_MIN_K, RICH_BLACK_MIN_CMY)) {
          before.push('0 0 0 1 k');
          after.push(gs.outFill);
          stats.richBlackText++;
        }
      }

      if (replace !== undefined || before.length > 0 || after.length > 0) {
        splices.push({ start: op.start, end: op.end, text: [...before, replace ?? serializeOp(op), ...after].join(' ') });
      }
    }
    return splices.length > 0 ? spliceAll(content, splices) : undefined;
  }

  // ---------- 資源 ----------

  private refKey(o: PDFObject | undefined): string | undefined {
    return o instanceof PDFRef ? o.toString() : undefined;
  }

  private async replaceStream(ref: PDFRef, stream: PDFStream, content: Uint8Array): Promise<PDFStream> {
    const next = this.doc.context.flateStream(content);
    for (const [k, v] of stream.dict.entries()) {
      const key = k.decodeText();
      if (key !== 'Filter' && key !== 'DecodeParms' && key !== 'Length') next.dict.set(k, v);
    }
    this.doc.context.assign(ref, next);
    return next;
  }

  /** 透明グループの色空間を CMYK にする */
  fixGroup(dict: PDFDict): void {
    const group = resolve(this.doc, dict.get(N('Group')));
    if (!(group instanceof PDFDict)) return;
    const cs = group.get(N('CS'));
    if (!cs) return;
    const space = resolveColorSpace(this.doc, cs, undefined);
    if (space.kind === 'rgb' || space.kind === 'gray' || space.kind === 'lab') group.set(N('CS'), N('DeviceCMYK'));
  }

  private async convertXObject(name: string, resources: PDFDict, stats: Stats): Promise<void> {
    const xobjects = resolve(this.doc, resources.get(N('XObject')));
    const ref = xobjects instanceof PDFDict ? xobjects.get(N(name)) : undefined;
    const key = this.refKey(ref);
    if (!key || this.done.has(key)) return;
    this.done.add(key);
    const x = resolve(this.doc, ref);
    if (!(x instanceof PDFStream)) return;
    const subtype = resolve(this.doc, x.dict.get(N('Subtype')))?.toString();
    if (subtype === '/Image') await this.convertImage(ref as PDFRef, x, resources, stats);
    else if (subtype === '/Form') {
      this.fixGroup(x.dict);
      const own = resolve(this.doc, x.dict.get(N('Resources')));
      const formResources = own instanceof PDFDict ? own : resources;
      let content: Uint8Array;
      try {
        content = streamBytes(x);
      } catch {
        stats.unsupported.add('読めないグループ');
        return;
      }
      const next = await this.rewrite(content, formResources, stats);
      if (next) await this.replaceStream(ref as PDFRef, x, next);
    }
  }

  private async convertType3(fontName: string, resources: PDFDict, stats: Stats): Promise<void> {
    const fonts = resolve(this.doc, resources.get(N('Font')));
    const ref = fonts instanceof PDFDict ? fonts.get(N(fontName)) : undefined;
    const key = this.refKey(ref);
    if (!key || this.done.has(key)) return;
    this.done.add(key);
    const font = resolve(this.doc, ref);
    if (!(font instanceof PDFDict) || resolve(this.doc, font.get(N('Subtype')))?.toString() !== '/Type3') return;
    const procs = resolve(this.doc, font.get(N('CharProcs')));
    const own = resolve(this.doc, font.get(N('Resources')));
    if (!(procs instanceof PDFDict)) return;
    for (const [, procRef] of procs.entries()) {
      const proc = resolve(this.doc, procRef);
      if (!(proc instanceof PDFStream) || !(procRef instanceof PDFRef)) continue;
      const next = await this.rewrite(streamBytes(proc), own instanceof PDFDict ? own : resources, stats);
      if (next) await this.replaceStream(procRef, proc, next);
    }
  }

  private async convertPatterns(resources: PDFDict, stats: Stats): Promise<void> {
    const patterns = resolve(this.doc, resources.get(N('Pattern')));
    if (!(patterns instanceof PDFDict)) return;
    for (const [, ref] of patterns.entries()) {
      const key = this.refKey(ref);
      if (key && this.done.has(key)) continue;
      if (key) this.done.add(key);
      const p = resolve(this.doc, ref);
      const dict = p instanceof PDFStream ? p.dict : p instanceof PDFDict ? p : undefined;
      if (!dict) continue;
      const type = (resolve(this.doc, dict.get(N('PatternType'))) as PDFNumber | undefined)?.asNumber();
      if (type === 2) {
        const sh = dict.get(N('Shading'));
        this.convertShadingObject(sh, stats);
      } else if (type === 1 && p instanceof PDFStream && ref instanceof PDFRef) {
        const paintType = (resolve(this.doc, dict.get(N('PaintType'))) as PDFNumber | undefined)?.asNumber();
        if (paintType === 2) continue; // 色を持たない模様は、使う側の色(scn)で変換される…ただし下地の色空間は変えられない
        const own = resolve(this.doc, dict.get(N('Resources')));
        const next = await this.rewrite(streamBytes(p), own instanceof PDFDict ? own : resources, stats);
        if (next) await this.replaceStream(ref, p, next);
      }
    }
  }

  private convertShadingResource(name: string, resources: PDFDict, stats: Stats): void {
    const shadings = resolve(this.doc, resources.get(N('Shading')));
    const sh = shadings instanceof PDFDict ? shadings.get(N(name)) : undefined;
    this.convertShadingObject(sh, stats);
  }

  /** グラデーションの色空間を CMYK にし、関数を CMYK の標本の関数に置き換える(辞書を直接書き換える) */
  private convertShadingObject(obj: PDFObject | undefined, stats: Stats): void {
    const key = this.refKey(obj);
    if (key && this.done.has(key)) return;
    if (key) this.done.add(key);
    const sh = resolve(this.doc, obj);
    const dict = sh instanceof PDFStream ? sh.dict : sh instanceof PDFDict ? sh : undefined;
    if (!dict) return;
    const space = resolveColorSpace(this.doc, dict.get(N('ColorSpace')), undefined);
    if (!this.needsConversion(space) && space.kind !== 'gray') return;
    if (space.kind === 'gray') return; // グレーは K として刷られるので、そのままでよい
    const type = (resolve(this.doc, dict.get(N('ShadingType'))) as PDFNumber | undefined)?.asNumber() ?? 0;
    const fnObj = dict.get(N('Function'));
    const fn = fnObj ? this.fn(fnObj) : undefined;
    if (!fn) {
      stats.unsupported.add(type >= 4 ? '頂点に色を持つグラデーション' : '読めないグラデーション');
      return;
    }
    const toCmyk = (comps: number[]) => this.toCmyk(space, comps, true) ?? [0, 0, 0, 0];
    const numbers = (k: string) => {
      const a = resolve(this.doc, dict.get(N(k)));
      return a instanceof PDFArray ? a.asArray().map((x) => (resolve(this.doc, x) as PDFNumber | undefined)?.asNumber() ?? 0) : undefined;
    };
    const ctx = this.doc.context;
    let sampled: PDFRef;
    if (type === 1) {
      // 2 変数の関数: 33 × 33 の標本
      const domain = numbers('Domain') ?? [0, 1, 0, 1];
      const size = 33;
      const data = new Uint8Array(size * size * 4);
      for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++) {
          const x = domain[0] + ((domain[1] - domain[0]) * i) / (size - 1);
          const y = domain[2] + ((domain[3] - domain[2]) * j) / (size - 1);
          toCmyk(fn([x, y])).forEach((v, k) => (data[(j * size + i) * 4 + k] = Math.round(v * 255)));
        }
      sampled = ctx.register(ctx.stream(data, { FunctionType: 0, Domain: domain, Range: [0, 1, 0, 1, 0, 1, 0, 1], Size: [size, size], BitsPerSample: 8 }));
    } else {
      // 1 変数の関数(軸・放射・メッシュの t): 256 の標本
      const fnDict = resolve(this.doc, fnObj);
      const fnDomain = fnDict instanceof PDFArray ? undefined : (() => {
        const d = fnDict instanceof PDFStream ? fnDict.dict : fnDict instanceof PDFDict ? fnDict : undefined;
        const a = d ? resolve(this.doc, d.get(N('Domain'))) : undefined;
        return a instanceof PDFArray ? a.asArray().map((x) => (resolve(this.doc, x) as PDFNumber).asNumber()) : undefined;
      })();
      const domain = (type >= 4 ? undefined : numbers('Domain')) ?? fnDomain ?? [0, 1];
      const size = 256;
      const data = new Uint8Array(size * 4);
      for (let i = 0; i < size; i++) {
        const t = domain[0] + ((domain[1] - domain[0]) * i) / (size - 1);
        toCmyk(fn([t])).forEach((v, k) => (data[i * 4 + k] = Math.round(v * 255)));
      }
      sampled = ctx.register(ctx.stream(data, { FunctionType: 0, Domain: [domain[0], domain[1]], Range: [0, 1, 0, 1, 0, 1, 0, 1], Size: [size], BitsPerSample: 8 }));
    }
    const background = numbers('Background');
    if (background) dict.set(N('Background'), ctx.obj(toCmyk(background)));
    dict.set(N('ColorSpace'), N('DeviceCMYK'));
    dict.set(N('Function'), sampled);
    stats.shadings++;
  }

  // ---------- 画像 ----------

  private async convertImage(ref: PDFRef, image: PDFStream, resources: PDFDict, stats: Stats): Promise<void> {
    const doc = this.doc;
    const dict = image.dict;
    if (resolve(doc, dict.get(N('ImageMask')))?.toString() === 'true') return;
    const space = resolveColorSpace(doc, dict.get(N('ColorSpace')), resources);
    if (!this.needsConversion(space)) {
      if (space.kind === 'unknown' && dict.has(N('ColorSpace'))) stats.unsupported.add('色空間の分からない画像');
      return;
    }
    const width = (resolve(doc, dict.get(N('Width'))) as PDFNumber | undefined)?.asNumber() ?? 0;
    const height = (resolve(doc, dict.get(N('Height'))) as PDFNumber | undefined)?.asNumber() ?? 0;
    const bpc = (resolve(doc, dict.get(N('BitsPerComponent'))) as PDFNumber | undefined)?.asNumber() ?? 8;
    const count = width * height;
    if (count === 0) return;

    // 色空間が Indexed なら、色の表だけを変換する(画素のデータは変えない)
    if (space.kind === 'indexed' && space.base) {
      const arr = space.obj as PDFArray;
      const hival = (resolve(doc, arr.get(2)) as PDFNumber | undefined)?.asNumber() ?? 0;
      const table = new Uint8Array((hival + 1) * 4);
      for (let i = 0; i <= hival; i++) {
        const c = this.toCmyk(space, [i], false) ?? [0, 0, 0, 0];
        c.forEach((v, k) => (table[i * 4 + k] = Math.round(v * 255)));
      }
      dict.set(N('ColorSpace'), doc.context.obj([N('Indexed'), N('DeviceCMYK'), hival, PDFHexString.of(Array.from(table, (b) => b.toString(16).padStart(2, '0')).join(''))]));
      stats.images++;
      return;
    }

    const pixels = await this.decodePixels(image, space, width, height, bpc, stats);
    if (!pixels) return;
    let cmyk: Uint8Array;
    if (space.kind === 'rgb') {
      cmyk = convertRgbPixels(pixels.data, pixels.channels as 3 | 4, count);
    } else {
      // Lab・特色: 画素の値ごとに変換する(同じ値は覚えておく)
      const n = space.n;
      const cache = new Map<string, Cmyk>();
      cmyk = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const raw = Array.from({ length: n }, (_, k) => pixels.data[i * pixels.channels + k]);
        const keyStr = raw.join(',');
        let c = cache.get(keyStr);
        if (!c) {
          const comps = space.kind === 'lab' ? [raw[0] / 2.55, raw[1] - 128, raw[2] - 128] : raw.map((x) => x / 255);
          c = this.toCmyk(space, comps, false) ?? [0, 0, 0, 0];
          cache.set(keyStr, c);
        }
        for (let k = 0; k < 4; k++) cmyk[i * 4 + k] = Math.round(c[k] * 255);
      }
    }
    const next = doc.context.flateStream(cmyk, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 });
    for (const k of ['SMask', 'Interpolate', 'Intent', 'Metadata']) {
      const v = dict.get(N(k));
      if (v) next.dict.set(N(k), v);
    }
    // ステンシルのマスク(画像)は残す。色で抜くマスク(配列)は RGB の値なので外す
    const mask = dict.get(N('Mask'));
    if (mask && !(resolve(doc, mask) instanceof PDFArray)) next.dict.set(N('Mask'), mask);
    doc.context.assign(ref, next);
    stats.images++;
  }

  /** 画像の画素を 8 ビットに読み出す。読めなければ理由を記録して undefined */
  private async decodePixels(
    image: PDFStream,
    space: ColorSpaceInfo,
    width: number,
    height: number,
    bpc: number,
    stats: Stats,
  ): Promise<{ data: Uint8Array | Uint8ClampedArray; channels: number } | undefined> {
    const doc = this.doc;
    const filterObj = resolve(doc, image.dict.get(N('Filter')));
    const filters = filterObj instanceof PDFArray ? filterObj.asArray().map((f) => resolve(doc, f)?.toString() ?? '') : filterObj ? [filterObj.toString()] : [];
    if (filters.some((f) => f === '/JPXDecode' || f === '/JBIG2Decode' || f === '/CCITTFaxDecode')) {
      stats.unsupported.add('JPEG 2000 などの画像');
      return undefined;
    }
    if (!(image instanceof PDFRawStream)) {
      stats.unsupported.add('読めない画像');
      return undefined;
    }
    if (filters[filters.length - 1] === '/DCTDecode') {
      if (!this.options.decodeJpeg || space.kind !== 'rgb') {
        stats.unsupported.add('JPEG の画像');
        return undefined;
      }
      let jpeg = image.contents;
      if (filters.length > 1) {
        try {
          const partial = PDFRawStream.of(image.dict.clone(doc.context), image.contents);
          partial.dict.set(N('Filter'), doc.context.obj(filters.slice(0, -1).map((f) => N(f.slice(1)))));
          jpeg = decodePDFRawStream(partial).decode();
        } catch {
          stats.unsupported.add('読めない画像');
          return undefined;
        }
      }
      const decoded = await this.options.decodeJpeg(jpeg);
      if (decoded.width !== width || decoded.height !== height) {
        stats.unsupported.add('大きさの合わない JPEG');
        return undefined;
      }
      return { data: decoded.data, channels: decoded.channels };
    }
    let raw: Uint8Array;
    try {
      raw = decodePDFRawStream(image).decode();
    } catch {
      stats.unsupported.add('読めない画像');
      return undefined;
    }
    const params = resolve(doc, image.dict.get(N('DecodeParms')));
    const parms = params instanceof PDFArray ? resolve(doc, params.get(filters.length - 1)) : params;
    const predictor = parms instanceof PDFDict ? (resolve(doc, parms.get(N('Predictor'))) as PDFNumber | undefined)?.asNumber() ?? 1 : 1;
    const n = space.n;
    if (predictor >= 10) raw = unfilterPng(raw, n, bpc, width);
    else if (predictor === 2 && bpc === 8) unfilterTiff(raw, n, width, height);
    if (bpc !== 8 && bpc !== 16) {
      stats.unsupported.add(`${bpc} ビットの画像`);
      return undefined;
    }
    if (bpc === 16) raw = raw.filter((_, i) => i % 2 === 0);
    if (raw.length < width * height * n) {
      stats.unsupported.add('データの足りない画像');
      return undefined;
    }
    // Decode 配列(反転など)を反映する
    const decode = resolve(doc, image.dict.get(N('Decode')));
    if (decode instanceof PDFArray && space.kind === 'rgb') {
      const d = decode.asArray().map((x) => (resolve(doc, x) as PDFNumber).asNumber());
      const inverted = d.some((v, i) => (i % 2 === 0 ? v !== 0 : v !== 1));
      if (inverted) {
        raw = Uint8Array.from(raw);
        for (let i = 0; i < width * height * n; i++) {
          const k = i % n;
          raw[i] = Math.round((d[2 * k] + (raw[i] / 255) * (d[2 * k + 1] - d[2 * k])) * 255);
        }
      }
    }
    return { data: raw, channels: n };
  }
}

/** PNG の予測(Predictor 10〜15)を戻す */
export function unfilterPng(data: Uint8Array, colors: number, bpc: number, columns: number): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - rowBytes + i] : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/** TIFF の予測(Predictor 2、8 ビット)をその場で戻す */
function unfilterTiff(data: Uint8Array, colors: number, width: number, height: number): void {
  for (let y = 0; y < height; y++)
    for (let x = 1; x < width; x++)
      for (let c = 0; c < colors; c++) {
        const i = (y * width + x) * colors + c;
        data[i] = (data[i] + data[i - colors]) & 0xff;
      }
}

export async function adjustColors(bytes: Uint8Array, options: ColorOptions, progress: (text: string) => void = () => {}): Promise<ColorResult> {
  const doc = await loadPdfForEditOrThrow(bytes);
  const converter = new Converter(doc, options);
  const pages: ColorPageResult[] = [];
  const all = doc.getPages();
  const targets = all.map((_, i) => i).filter((i) => !options.targetPages || options.targetPages === 'all' || options.targetPages.has(i));
  for (const [k, i] of targets.entries()) {
    progress(`色を調整しています…(${k + 1} / ${targets.length})`);
    const page = all[i];
    const stats: Stats = { colors: 0, images: 0, shadings: 0, richBlackText: 0, whiteOverprint: 0, unsupported: new Set() };
    let resources = page.node.Resources();
    if (!resources) {
      resources = doc.context.obj({});
      page.node.set(N('Resources'), resources);
    }
    if (options.mode === 'cmyk') converter.fixGroup(page.node);
    const next = await converter.rewrite(pageContentBytes(doc, page), resources, stats);
    if (next) page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(next)));
    pages.push({ page: i, ...stats, unsupported: [...stats.unsupported] });
  }
  return { bytes: await doc.save({ useObjectStreams: true }), pages };
}
