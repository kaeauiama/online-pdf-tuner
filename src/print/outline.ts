// 文字のアウトライン化(D-034): 文字を、埋め込まれたフォントの字形の輪郭(図形)に置き換える。
// 印刷所の機械にフォントがなくても、見えているとおりの形で刷られるようにするための処理。
//
// - 文字の塊(BT 〜 ET)ごとに処理する。塊の中の文字表示の命令を、字形ごとの図形の描画に置き換える。
//   字形の輪郭はフォーム XObject として 1 度だけ作り、`q 行列 cm /字形 Do Q` で描く(塗りの色は引き継がれる)
// - 文字の描画モード: 塗り(0)はフォーム、線(1)・塗りと線(2)はその場でパスを描く、見えない文字(3)は削除する
// - 塊の中に、輪郭にできないフォント(埋め込みなし・埋め込み不可・未対応の形式・Type3)や、クリップのモード(4〜7)の
//   文字があれば、その塊は文字のまま残す。直前の文字の状態(フォント・字間など)を前に書き足して、見た目を保つ
// - フォーム XObject の中の文字も同じように処理する
import { PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { loadOutlineFont, type OutlineFont, type OutlineFontResult } from '../pdf/glyphs.ts';
import { lexContent, name as opName, num, type ContentOp } from '../pdf/lexer.ts';
import { serializeOp, serializeOperand, spliceAll, type Splice } from '../pdf/serialize.ts';
import { IDENTITY, multiply, type Matrix } from './geometry.ts';
import { pageContentBytes, streamBytes } from './structure.ts';

export type OutlineKeptReason = 'not-embedded' | 'restricted' | 'unsupported' | 'type3' | 'clip' | 'glyph-missing' | 'unknown-font';

export interface OutlinePageResult {
  readonly page: number;
  /** 図形にした字の数 */
  readonly glyphs: number;
  /** 削除した見えない文字(描画モード 3)の字の数 */
  readonly removedInvisible: number;
  /** 文字のまま残したもの(フォントごと) */
  readonly kept: readonly { readonly reason: OutlineKeptReason; readonly font: string; readonly detail?: string }[];
}

export interface OutlineResult {
  readonly bytes: Uint8Array;
  readonly pages: readonly OutlinePageResult[];
}

const N = (s: string) => PDFName.of(s);
const SHOW = new Set(['Tj', 'TJ', "'", '"']);
const TEXT_STATE = new Set(['Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Ts', 'Tr']);
const TEXT_POSITION = new Set(['Td', 'TD', 'Tm', 'T*']);

interface TextState {
  font?: string;
  size: number;
  tc: number;
  tw: number;
  tz: number;
  tl: number;
  ts: number;
  tr: number;
  lineWidth: number;
}

const fmt = (v: number) => {
  if (Math.abs(v) < 1e-9) return '0';
  const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
const fmtMatrix = (m: Matrix) => m.map(fmt).join(' ');

/** 文字の状態を、命令として書き出す(文字のまま残す塊の前に置く) */
function stateOps(s: TextState): string {
  const font = s.font ? `${serializeOperand({ type: 'name', value: s.font })} ${fmt(s.size)} Tf ` : '';
  return `${font}${fmt(s.tc)} Tc ${fmt(s.tw)} Tw ${fmt(s.tz)} Tz ${fmt(s.tl)} TL ${fmt(s.ts)} Ts ${fmt(s.tr)} Tr `;
}

function applyTextState(s: TextState, op: ContentOp): void {
  const o = op.operands;
  switch (op.op) {
    case 'Tf':
      s.font = opName(o[0]);
      s.size = num(o[1]);
      break;
    case 'Tc':
      s.tc = num(o[0]);
      break;
    case 'Tw':
      s.tw = num(o[0]);
      break;
    case 'Tz':
      s.tz = num(o[0]);
      break;
    case 'TL':
      s.tl = num(o[0]);
      break;
    case 'Ts':
      s.ts = num(o[0]);
      break;
    case 'Tr':
      s.tr = num(o[0]);
      break;
    case 'TD':
      s.tl = -num(o[1]);
      break;
    case '"':
      s.tw = num(o[0]);
      s.tc = num(o[1]);
      break;
  }
}

interface Context {
  readonly doc: PDFDocument;
  /** フォントの参照 → 読み込み結果 */
  readonly fonts: Map<string, OutlineFontResult>;
  /** 字形 → フォーム XObject */
  readonly glyphForms: Map<string, PDFRef>;
  readonly processedForms: Set<string>;
  glyphs: number;
  removedInvisible: number;
  readonly kept: Map<string, { reason: OutlineKeptReason; font: string; detail?: string }>;
}

function resolve(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}

/** 資源の辞書を複製してから書き換える(ほかのページと共有している場合に、そちらを変えないため) */
function ownDict(doc: PDFDocument, parent: PDFDict, key: string): PDFDict {
  const v = resolve(doc, parent.get(N(key)));
  const copy = v instanceof PDFDict ? v.clone(doc.context) : doc.context.obj({});
  parent.set(N(key), copy);
  return copy;
}

/** 資源の文字表示用のフォントを読み込む(資源の名前 → 結果) */
async function loadFonts(ctx: Context, resources: PDFDict): Promise<Map<string, OutlineFontResult>> {
  const map = new Map<string, OutlineFontResult>();
  const dict = resolve(ctx.doc, resources.get(N('Font')));
  if (!(dict instanceof PDFDict)) return map;
  for (const [key, ref] of dict.entries()) {
    const id = ref instanceof PDFRef ? ref.toString() : `inline:${key.decodeText()}`;
    let result = ctx.fonts.get(id);
    if (!result) {
      result = await loadOutlineFont(ctx.doc, ref);
      ctx.fonts.set(id, result);
    }
    map.set(key.decodeText(), result);
  }
  return map;
}

/** 字形のフォーム XObject の名前(この資源の辞書での名前) */
function glyphFormName(ctx: Context, xobjects: PDFDict, names: Map<string, string>, key: string, path: string, bbox: readonly number[]): string {
  let name = names.get(key);
  if (name) return name;
  let ref = ctx.glyphForms.get(key);
  if (!ref) {
    const stream = ctx.doc.context.flateStream(new TextEncoder().encode(`${path} f`), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1],
      Resources: {},
    });
    ref = ctx.doc.context.register(stream);
    ctx.glyphForms.set(key, ref);
  }
  let i = names.size;
  do name = `OLg${i++}`;
  while (xobjects.has(N(name)));
  xobjects.set(N(name), ref);
  names.set(key, name);
  return name;
}

interface StreamResult {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
}

/** コンテンツ 1 本を書き換える。resources は(必要なら複製済みの)そのコンテンツの資源 */
async function rewriteContent(ctx: Context, content: Uint8Array, resources: PDFDict, initial: TextState): Promise<StreamResult> {
  const ops = lexContent(content);
  const fonts = await loadFonts(ctx, resources);
  let xobjects: PDFDict | undefined;
  const glyphNames = new Map<string, string>();
  const splices: Splice[] = [];
  let state: TextState = { ...initial };
  const stack: TextState[] = [];
  let changed = false;

  const keep = (fontRes: string | undefined, result: OutlineFontResult | undefined, reason?: OutlineKeptReason) => {
    const name = result && !result.ok ? result.name : (fontRes ?? '(不明)');
    const r: OutlineKeptReason = reason ?? (result && !result.ok ? result.reason : 'unknown-font');
    if (r === 'type3') return; // Type3 はもともと図形なので、残しても問題にならない
    ctx.kept.set(`${r}:${name}`, { reason: r, font: name, detail: result && !result.ok ? result.detail : undefined });
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'q') stack.push({ ...state });
    else if (op.op === 'Q') state = stack.pop() ?? state;
    else if (op.op === 'w') state.lineWidth = num(op.operands[0]);
    else if (TEXT_STATE.has(op.op)) applyTextState(state, op);
    else if (op.op === 'Do') {
      await rewriteForm(ctx, opName(op.operands[0]) ?? '', resources, state);
    } else if (op.op === 'BT') {
      let j = i + 1;
      while (j < ops.length && ops[j].op !== 'ET') j++;
      if (j >= ops.length) break; // ET のない壊れた塊は、そのまま残す
      const block = ops.slice(i, j + 1);
      const start = { ...state };
      // 塊の中を一度たどって、輪郭にできるかを確かめる
      const probe: TextState = { ...state };
      let ok = true;
      for (const b of block) {
        applyTextState(probe, b);
        if (!SHOW.has(b.op)) continue;
        if (probe.tr >= 4) {
          ok = false;
          keep(probe.font, undefined, 'clip');
          continue;
        }
        const result = probe.font ? fonts.get(probe.font) : undefined;
        if (!result || !result.ok) {
          ok = false;
          keep(probe.font, result);
          continue;
        }
        if (!glyphsAvailable(result.font, b)) {
          ok = false;
          ctx.kept.set(`glyph-missing:${result.font.name}`, { reason: 'glyph-missing', font: result.font.name });
        }
      }
      if (!ok) {
        // 文字のまま残す: 直前の文字の状態を前に書き足す(前の塊を図形にしたとき、状態の命令を取り除いているため)
        splices.push({ start: op.start, end: op.start, text: stateOps(start) });
        state = probe;
        changed = true;
        i = j;
        continue;
      }
      xobjects ??= ownDict(ctx.doc, resources, 'XObject');
      const out = drawBlock(ctx, block, state, fonts, (key, path, bbox) => glyphFormName(ctx, xobjects!, glyphNames, key, path, bbox));
      splices.push({ start: op.start, end: ops[j].end, text: out });
      changed = true;
      i = j;
    }
  }
  if (!changed) return { bytes: content, changed: false };
  return { bytes: spliceAll(content, splices), changed: true };
}

/** 文字表示の命令の文字列の部品(TJ の配列、または 1 つの文字列) */
function showItems(op: ContentOp) {
  const o = op.operands;
  if (op.op === 'TJ' && o[0]?.type === 'array') return o[0].items;
  const s = o[op.op === '"' ? 2 : 0];
  return s ? [s] : [];
}

function codesOf(font: OutlineFont, bytes: Uint8Array): number[] {
  const codes: number[] = [];
  for (let i = 0; i + font.codeBytes <= bytes.length; i += font.codeBytes) codes.push(font.codeBytes === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i]);
  return codes;
}

function glyphsAvailable(font: OutlineFont, op: ContentOp): boolean {
  for (const item of showItems(op)) {
    if (item.type !== 'string') continue;
    for (const code of codesOf(font, item.bytes)) if (!font.glyph(code)) return false;
  }
  return true;
}

/** 文字の塊を、図形の描画の命令に置き換える */
function drawBlock(
  ctx: Context,
  block: readonly ContentOp[],
  state: TextState,
  fonts: Map<string, OutlineFontResult>,
  formName: (key: string, path: string, bbox: readonly number[]) => string,
): string {
  const out: string[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const nextLine = () => {
    tlm = multiply([1, 0, 0, 1, 0, -state.tl], tlm);
    tm = tlm;
  };
  for (const op of block) {
    const o = op.operands;
    switch (op.op) {
      case 'BT':
      case 'ET':
        break;
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case 'TD':
        applyTextState(state, op);
        tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])];
        tm = tlm;
        break;
      case 'T*':
        nextLine();
        break;
      case "'":
      case '"':
        applyTextState(state, op);
        nextLine();
        tm = drawShow(ctx, op, state, tm, fonts, formName, out);
        break;
      case 'Tj':
      case 'TJ':
        tm = drawShow(ctx, op, state, tm, fonts, formName, out);
        break;
      default:
        if (TEXT_STATE.has(op.op)) applyTextState(state, op);
        else if (op.op === 'w') {
          state.lineWidth = num(o[0]);
          out.push(serializeOp(op));
        } else if (!TEXT_POSITION.has(op.op)) {
          // 色・gs・マークなど(文字の塊の外でも使える命令)はそのまま残す
          out.push(serializeOp(op));
        }
    }
  }
  return out.join('\n');
}

function drawShow(
  ctx: Context,
  op: ContentOp,
  state: TextState,
  tmIn: Matrix,
  fonts: Map<string, OutlineFontResult>,
  formName: (key: string, path: string, bbox: readonly number[]) => string,
  out: string[],
): Matrix {
  const result = fonts.get(state.font ?? '');
  if (!result?.ok) return tmIn;
  const font = result.font;
  const size = state.size;
  const th = state.tz / 100;
  let tm = tmIn;
  for (const item of showItems(op)) {
    if (item.type === 'number') {
      const d = (-item.value / 1000) * size;
      tm = multiply(font.vertical ? [1, 0, 0, 1, 0, d] : [1, 0, 0, 1, d * th, 0], tm);
      continue;
    }
    if (item.type !== 'string') continue;
    for (const code of codesOf(font, item.bytes)) {
      const glyph = font.glyph(code)!;
      const space = font.codeBytes === 1 && code === 32 ? state.tw : 0;
      let m: Matrix;
      if (font.vertical) {
        const v = font.verticalMetrics(code);
        m = multiply(multiply([glyph.scale, 0, 0, glyph.scale, -v.vx / 1000, -v.vy / 1000], [size, 0, 0, size, 0, 0]), tm);
      } else {
        m = multiply([glyph.scale * size * th, 0, 0, glyph.scale * size, 0, state.ts], tm);
      }
      if (glyph.path !== '') {
        if (state.tr === 3) ctx.removedInvisible++;
        else {
          ctx.glyphs++;
          if (state.tr === 0) {
            out.push(`q ${fmtMatrix(m)} cm /${formName(glyph.key, glyph.path, glyph.bbox)} Do Q`);
          } else {
            // 線の太さは、字形の空間に直して指定する(cm で縮小されるため)
            const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
            out.push(`q ${fmtMatrix(m)} cm ${fmt(state.lineWidth / scale)} w ${glyph.path} ${state.tr === 1 ? 'S' : 'B'} Q`);
          }
        }
      }
      if (font.vertical) {
        const ty = (font.verticalMetrics(code).w1 / 1000) * size + state.tc + space;
        tm = multiply([1, 0, 0, 1, 0, ty], tm);
      } else {
        const tx = ((font.widthOf(code) / 1000) * size + state.tc + space) * th;
        tm = multiply([1, 0, 0, 1, tx, 0], tm);
      }
    }
  }
  return tm;
}

/** フォーム XObject の中の文字を処理する(同じフォームは 1 度だけ) */
async function rewriteForm(ctx: Context, name: string, resources: PDFDict, state: TextState): Promise<void> {
  const xobjects = resolve(ctx.doc, resources.get(N('XObject')));
  const ref = xobjects instanceof PDFDict ? xobjects.get(N(name)) : undefined;
  if (!(ref instanceof PDFRef) || ctx.processedForms.has(ref.toString())) return;
  ctx.processedForms.add(ref.toString());
  const form = ctx.doc.context.lookup(ref);
  if (!(form instanceof PDFStream) || resolve(ctx.doc, form.dict.get(N('Subtype')))?.toString() !== '/Form') return;
  const own = resolve(ctx.doc, form.dict.get(N('Resources')));
  const formResources = own instanceof PDFDict ? own.clone(ctx.doc.context) : resources;
  let content: Uint8Array;
  try {
    content = streamBytes(form);
  } catch {
    return;
  }
  const result = await rewriteContent(ctx, content, formResources, { ...state });
  if (!result.changed) return;
  const next = ctx.doc.context.flateStream(result.bytes);
  for (const [k, v] of form.dict.entries()) {
    const key = k.decodeText();
    if (key !== 'Filter' && key !== 'DecodeParms' && key !== 'Length') next.dict.set(k, v);
  }
  if (own instanceof PDFDict) next.dict.set(N('Resources'), formResources);
  ctx.doc.context.assign(ref, next);
}

/** 書き換え後のコンテンツで使われていないフォントを、資源から外す(図形にしたフォント) */
function dropUnusedFonts(ctx: Context, resources: PDFDict, content: Uint8Array): void {
  const used = new Set(lexContent(content).flatMap((op) => (op.op === 'Tf' ? [opName(op.operands[0]) ?? ''] : [])));
  const fonts = resolve(ctx.doc, resources.get(N('Font')));
  if (!(fonts instanceof PDFDict)) return;
  const copy = fonts.clone(ctx.doc.context);
  for (const [key] of fonts.entries()) if (!used.has(key.decodeText())) copy.delete(key);
  resources.set(N('Font'), copy);
}

const INITIAL: TextState = { size: 0, tc: 0, tw: 0, tz: 100, tl: 0, ts: 0, tr: 0, lineWidth: 1 };

export async function outlineText(
  bytes: Uint8Array,
  targetPages: ReadonlySet<number> | 'all',
  progress: (text: string) => void = () => {},
): Promise<OutlineResult> {
  const doc = await loadPdfForEditOrThrow(bytes);
  const shared = { fonts: new Map<string, OutlineFontResult>(), glyphForms: new Map<string, PDFRef>(), processedForms: new Set<string>() };
  const pages: OutlinePageResult[] = [];
  const all = doc.getPages();
  const targets = all.map((_, i) => i).filter((i) => targetPages === 'all' || targetPages.has(i));
  for (const [k, i] of targets.entries()) {
    progress(`文字をアウトライン化しています…(${k + 1} / ${targets.length})`);
    const page = all[i];
    const ctx: Context = { doc, ...shared, glyphs: 0, removedInvisible: 0, kept: new Map() };
    const original = page.node.Resources();
    const resources = original ? original.clone(doc.context) : doc.context.obj({});
    page.node.set(N('Resources'), resources);
    const content = pageContentBytes(doc, page);
    const result = await rewriteContent(ctx, content, resources, { ...INITIAL });
    if (result.changed) {
      page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(result.bytes)));
      dropUnusedFonts(ctx, resources, result.bytes);
    }
    pages.push({ page: i, glyphs: ctx.glyphs, removedInvisible: ctx.removedInvisible, kept: [...ctx.kept.values()] });
  }
  return { bytes: await doc.save({ useObjectStreams: true }), pages };
}

