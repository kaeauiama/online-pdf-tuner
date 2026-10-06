// ページ内の編集(M6): ページの描画命令から「要素」(画像・文字・図形・グラデーション・グループ)を取り出す(純粋関数)。
// 設計: docs/spec/03-page-editor.md
//
// - いちばん内側の q 〜 Q の中にある描画を 1 つの要素にまとめる(Office の出力は、図形や文字の塊ごとに q 〜 Q で囲む)
// - 要素には、その q 〜 Q の命令の位置を持たせる。移動・削除はこの範囲に対して行う
// - 影・ぼかしなどの効果と、検索用の見えない文字は、描画の順番と位置から関連する要素を推定する
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { extGStateReader } from '../pdf/extgstate.ts';
import { loadFontForEdit, type FontForEdit } from '../pdf/fonts.ts';
import { lexContent, name as opName, num, type ContentOp } from '../pdf/lexer.ts';
import {
  applyToPoint,
  IDENTITY,
  intersectRect,
  multiply,
  rect,
  rectArea,
  transformRect,
  unionRect,
  unitSquareBounds,
  unitSquareSize,
  type Matrix,
  type Rect,
} from '../print/geometry.ts';
import { pageContentBytes } from '../print/structure.ts';

export type ElementKind = 'image' | 'text' | 'path' | 'shading' | 'group' | 'mixed';

export interface PaintEvent {
  readonly kind: Exclude<ElementKind, 'mixed'>;
  readonly opIndex: number;
  readonly bounds: Rect;
  /** 描画が見えない(不透明度 0 や、文字の描画モード 3) */
  readonly invisible: boolean;
  /** 半透明・ソフトマスク・描画モード・透明部分のある画像 */
  readonly transparent: boolean;
  /** 画像: 画素数と、表示上の解像度 */
  readonly pixels?: { readonly width: number; readonly height: number; readonly dpi: number };
  /** 文字: 読み出せた文字列 */
  readonly text?: string;
  readonly fontName?: string;
}

export interface PageElement {
  /** 描画の順番(0 が最初 = いちばん奥) */
  readonly id: number;
  readonly kind: ElementKind;
  readonly bounds: Rect;
  readonly events: readonly PaintEvent[];
  /** 要素を囲む q 〜 Q の命令の位置。ない(ページ直下の描画)なら移動できない */
  readonly block?: { readonly q: number; readonly Q: number };
  /** q の直後の CTM(移動のための cm を差し込むときに使う) */
  readonly ctm: Matrix;
  /** 移動・拡大縮小できるか(q 〜 Q があり、その中にほかの要素が入っていない) */
  readonly movable: boolean;
  readonly invisible: boolean;
  readonly transparent: boolean;
  /** 関連(推定): この要素が効果(影・ぼかしなど)として付いている要素の id */
  effectOf?: number;
  /** 関連(推定): この要素(見えない文字)が重なっている要素の id */
  overlayOf?: number;
}

interface GState {
  ctm: Matrix;
  fillAlpha: number;
  strokeAlpha: number;
  softMask: boolean;
  blend: boolean;
  clip: Rect | undefined;
  lineWidth: number;
  // 文字の状態(PDF では文字の状態もグラフィックス状態の一部)
  font: FontForEdit | undefined;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  textMode: number;
}

interface Level {
  readonly id: number;
  readonly q: number;
  readonly ctm: Matrix;
  Q?: number;
}

const N = (s: string) => PDFName.of(s);
const PATH_PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
const STROKE_PAINT = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const FILL_MODES = new Set([0, 2, 4, 6]);
const STROKE_MODES = new Set([1, 2, 5, 6]);
/** 字面の上下(和文フォントの目安) */
const DESCENT = 0.15;
const ASCENT = 0.85;

function pageFonts(doc: PDFDocument, resources: PDFDict | undefined): Map<string, FontForEdit> {
  const fonts = new Map<string, FontForEdit>();
  const dict = resources?.lookupMaybe(N('Font'), PDFDict);
  if (!dict) return fonts;
  for (const [key, ref] of dict.entries()) {
    const f = loadFontForEdit(doc, key.decodeText(), ref);
    if (f) fonts.set(key.decodeText(), f);
  }
  return fonts;
}

export function extractElements(doc: PDFDocument, page: PDFPage): PageElement[] {
  const lookup = <T>(o: unknown): T | undefined => (o instanceof PDFRef ? (doc.context.lookup(o) as T) : (o as T));
  const resources = page.node.Resources();
  const fonts = pageFonts(doc, resources);
  const gsInfo = extGStateReader(resources);
  const xobjects = resources?.lookupMaybe(N('XObject'), PDFDict);
  const media = page.getMediaBox();
  const pageRect = rect(media.x, media.y, media.x + media.width, media.y + media.height);

  const ops = lexContent(pageContentBytes(doc, page));
  let gs: GState = {
    ctm: IDENTITY,
    fillAlpha: 1,
    strokeAlpha: 1,
    softMask: false,
    blend: false,
    clip: undefined,
    lineWidth: 1,
    font: undefined,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    textMode: 0,
  };
  const gsStack: GState[] = [];
  const levels: Level[] = [];
  const openLevels: Level[] = [];
  const events: { event: PaintEvent; level: Level | undefined }[] = [];

  // パス
  let pathPoints: [number, number][] = [];
  let pendingClip = false;
  // 文字の行列
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;

  const clipBounds = (r: Rect): Rect => (gs.clip ? (intersectRect(r, gs.clip) ?? rect(r.x0, r.y0, r.x0, r.y0)) : r);
  const addEvent = (event: PaintEvent) => events.push({ event, level: openLevels[openLevels.length - 1] });
  const endPath = () => {
    if (pendingClip && pathPoints.length > 0) {
      const xs = pathPoints.map((p) => p[0]);
      const ys = pathPoints.map((p) => p[1]);
      const box = rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
      gs.clip = gs.clip ? (intersectRect(gs.clip, box) ?? rect(box.x0, box.y0, box.x0, box.y0)) : box;
    }
    pathPoints = [];
    pendingClip = false;
  };
  const point = (x: number, y: number) => pathPoints.push(applyToPoint(gs.ctm, x, y));

  let lastOpIndex = 0;
  const showText = (op: ContentOp) => {
    const font = gs.font;
    const size = gs.fontSize;
    const items =
      op.op === 'TJ' && op.operands[0]?.type === 'array'
        ? op.operands[0].items
        : [op.operands[op.op === '"' ? 2 : 0]].filter((o) => o !== undefined);
    let x = 0;
    let text = '';
    const codeBytes = font?.codeBytes ?? 1;
    for (const item of items) {
      if (item.type === 'number') {
        x -= (item.value / 1000) * size * gs.hScale;
        continue;
      }
      if (item.type !== 'string') continue;
      for (let i = 0; i + codeBytes <= item.bytes.length; i += codeBytes) {
        const code = codeBytes === 2 ? (item.bytes[i] << 8) | item.bytes[i + 1] : item.bytes[i];
        // 字幅が分からないフォント(標準 14 フォントなど)は 0.5em とみなす
        const w = (font ? font.widthOf(code) / 1000 : 0) || 0.5;
        const space = codeBytes === 1 && code === 32 ? gs.wordSpacing : 0;
        x += (w * size + gs.charSpacing + space) * gs.hScale;
        text += font?.toUnicode.get(code) ?? '';
      }
    }
    // 文字の空間での範囲(基準線の上下)を、文字の行列と CTM でページ座標に写す
    const box = rect(0, gs.rise - DESCENT * size, x, gs.rise + ASCENT * size);
    const bounds = clipBounds(transformRect(multiply(tm, gs.ctm), box));
    tm = multiply([1, 0, 0, 1, x, 0], tm);
    const fillVisible = FILL_MODES.has(gs.textMode) && gs.fillAlpha > 0;
    const strokeVisible = STROKE_MODES.has(gs.textMode) && gs.strokeAlpha > 0;
    const invisible = gs.textMode === 3 || gs.textMode === 7 || (!fillVisible && !strokeVisible);
    addEvent({
      kind: 'text',
      opIndex: lastOpIndex,
      bounds,
      invisible,
      transparent: !invisible && (gs.softMask || gs.blend || (fillVisible && gs.fillAlpha < 1) || (strokeVisible && gs.strokeAlpha < 1)),
      text,
      fontName: font?.name,
    });
  };

  ops.forEach((op, opIndex) => {
    lastOpIndex = opIndex;
    const o = op.operands;
    switch (op.op) {
      case 'q': {
        gsStack.push({ ...gs });
        const level: Level = { id: levels.length, q: opIndex, ctm: gs.ctm };
        levels.push(level);
        openLevels.push(level);
        break;
      }
      case 'Q': {
        gs = gsStack.pop() ?? gs;
        const level = openLevels.pop();
        if (level) level.Q = opIndex;
        break;
      }
      case 'cm':
        if (o.length === 6) gs.ctm = multiply([num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = num(o[0]);
        break;
      case 'gs': {
        const info = gsInfo(opName(o[0]) ?? '');
        if (info?.fillAlpha !== undefined) gs.fillAlpha = info.fillAlpha;
        if (info?.strokeAlpha !== undefined) gs.strokeAlpha = info.strokeAlpha;
        if (info?.softMask !== undefined) gs.softMask = info.softMask;
        if (info?.blend !== undefined) gs.blend = info.blend;
        break;
      }
      // ---- パス ----
      case 're': {
        const [x, y, w, h] = o.map(num);
        point(x, y);
        point(x + w, y);
        point(x, y + h);
        point(x + w, y + h);
        break;
      }
      case 'm':
      case 'l':
        point(num(o[0]), num(o[1]));
        break;
      case 'c':
        point(num(o[0]), num(o[1]));
        point(num(o[2]), num(o[3]));
        point(num(o[4]), num(o[5]));
        break;
      case 'v':
      case 'y':
        point(num(o[0]), num(o[1]));
        point(num(o[2]), num(o[3]));
        break;
      case 'W':
      case 'W*':
        pendingClip = true;
        break;
      case 'n':
        endPath();
        break;
      // ---- 文字 ----
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf':
        gs.font = fonts.get(opName(o[0]) ?? '');
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
      // ---- 画像・グループ・グラデーション ----
      case 'Do': {
        const ref = xobjects?.get(N(opName(o[0]) ?? ''));
        const x = lookup<PDFStream>(ref);
        if (!(x instanceof PDFStream)) break;
        const subtype = lookup<PDFName>(x.dict.get(N('Subtype')))?.decodeText();
        if (subtype === 'Image') {
          const width = lookup<PDFNumber>(x.dict.get(N('Width')))?.asNumber() ?? 0;
          const height = lookup<PDFNumber>(x.dict.get(N('Height')))?.asNumber() ?? 0;
          const size = unitSquareSize(gs.ctm);
          const dpi = Math.min(size.width > 0 ? width / (size.width / 72) : 0, size.height > 0 ? height / (size.height / 72) : 0);
          addEvent({
            kind: 'image',
            opIndex,
            bounds: clipBounds(unitSquareBounds(gs.ctm)),
            invisible: gs.fillAlpha <= 0,
            transparent: gs.fillAlpha < 1 || gs.softMask || gs.blend || x.dict.has(N('SMask')),
            pixels: { width, height, dpi },
          });
        } else if (subtype === 'Form') {
          const bbox = lookup<PDFArray>(x.dict.get(N('BBox')));
          const m = lookup<PDFArray>(x.dict.get(N('Matrix')));
          const nums = (a: PDFArray | undefined) => a?.asArray().map((v) => lookup<PDFNumber>(v)?.asNumber() ?? 0);
          const b = nums(bbox) ?? [0, 0, 0, 0];
          const matrix = (nums(m) as unknown as Matrix | undefined) ?? IDENTITY;
          addEvent({
            kind: 'group',
            opIndex,
            bounds: clipBounds(transformRect(multiply(matrix, gs.ctm), rect(b[0], b[1], b[2], b[3]))),
            invisible: gs.fillAlpha <= 0 && gs.strokeAlpha <= 0,
            // 透明グループ(/Group)は Office の出力に常に付くため、判定には使わない
            transparent: gs.fillAlpha < 1 || gs.softMask || gs.blend,
          });
        }
        break;
      }
      case 'BI': {
        const p = op.inlineImage!;
        const width = num(p.get('W') ?? p.get('Width'));
        const height = num(p.get('H') ?? p.get('Height'));
        const size = unitSquareSize(gs.ctm);
        addEvent({
          kind: 'image',
          opIndex,
          bounds: clipBounds(unitSquareBounds(gs.ctm)),
          invisible: gs.fillAlpha <= 0,
          transparent: gs.fillAlpha < 1 || gs.softMask || gs.blend,
          pixels: { width, height, dpi: Math.min(width / (size.width / 72 || 1), height / (size.height / 72 || 1)) },
        });
        break;
      }
      case 'sh':
        addEvent({ kind: 'shading', opIndex, bounds: gs.clip ?? pageRect, invisible: gs.fillAlpha <= 0, transparent: gs.fillAlpha < 1 || gs.softMask || gs.blend });
        break;
      default:
        if (PATH_PAINT.has(op.op)) {
          if (pathPoints.length > 0) {
            const xs = pathPoints.map((p) => p[0]);
            const ys = pathPoints.map((p) => p[1]);
            const half = STROKE_PAINT.has(op.op) ? (gs.lineWidth * Math.hypot(gs.ctm[0], gs.ctm[1])) / 2 : 0;
            const stroke = STROKE_PAINT.has(op.op);
            const fill = op.op !== 'S' && op.op !== 's';
            const alpha = Math.max(fill ? gs.fillAlpha : 0, stroke ? gs.strokeAlpha : 0);
            addEvent({
              kind: 'path',
              opIndex,
              bounds: clipBounds(rect(Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half)),
              invisible: alpha <= 0,
              transparent: alpha < 1 || gs.softMask || gs.blend,
            });
          }
          endPath();
        }
    }
  });

  // いちばん内側の q 〜 Q ごとにまとめる。q 〜 Q のない描画は 1 つずつ
  const groups = new Map<string, { level: Level | undefined; events: PaintEvent[] }>();
  const order: string[] = [];
  for (const { event, level } of events) {
    const key = level ? `L${level.id}` : `E${event.opIndex}`;
    let g = groups.get(key);
    if (!g) {
      g = { level, events: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.events.push(event);
  }

  const allEvents = events.map((x) => x.event);
  const elements: PageElement[] = order.map((key, id) => {
    const { level, events: evs } = groups.get(key)!;
    const block = level && level.Q !== undefined ? { q: level.q, Q: level.Q } : undefined;
    // q 〜 Q の中に、別の要素の描画が入っていれば、この範囲ごと動かすとその要素も動いてしまう
    const nested = block ? allEvents.some((ev) => !evs.includes(ev) && ev.opIndex > block.q && ev.opIndex < block.Q) : false;
    const kinds = new Set(evs.map((e) => e.kind));
    const visible = evs.filter((e) => !e.invisible);
    const bounds = (visible.length > 0 ? visible : evs).map((e) => e.bounds).reduce(unionRect);
    return {
      id,
      kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
      bounds,
      events: evs,
      block,
      ctm: level?.ctm ?? IDENTITY,
      movable: !!block && !nested,
      invisible: evs.every((e) => e.invisible),
      transparent: visible.some((e) => e.transparent),
    };
  });
  relate(elements);
  return elements;
}

/** a の面積のうち、b と重なる割合 */
function overlapRatio(a: Rect, b: Rect): number {
  const area = rectArea(a);
  if (area <= 0) return 0;
  const i = intersectRect(a, b);
  return i ? rectArea(i) / area : 0;
}

/** 効果(影・ぼかしなど)と見えない文字を、関連する要素に結びつける(推定) */
export function relate(elements: PageElement[]): void {
  const LOOK = 3;
  for (const e of elements) {
    if (e.invisible && e.kind === 'text') {
      // 見えない文字: すぐ前の画像・グループと重なっていれば、それに重ねた検索用の文字とみなす
      for (let k = e.id - 1; k >= Math.max(0, e.id - LOOK); k--) {
        const prev = elements[k];
        if ((prev.kind === 'image' || prev.kind === 'group' || prev.kind === 'mixed') && overlapRatio(e.bounds, prev.bounds) >= 0.5) {
          e.overlayOf = prev.id;
          break;
        }
      }
      continue;
    }
    if (!e.transparent || e.invisible) continue;
    // 効果: すぐ後の、透明でない要素と大きく重なっていれば、その要素の効果とみなす
    for (let k = e.id + 1; k <= Math.min(elements.length - 1, e.id + LOOK); k++) {
      const next = elements[k];
      if (next.invisible || next.transparent) continue;
      const areaRatio = rectArea(e.bounds) / Math.max(1e-6, rectArea(next.bounds));
      if (overlapRatio(e.bounds, next.bounds) >= 0.5 && areaRatio >= 0.5 && areaRatio <= 3) {
        e.effectOf = next.id;
        break;
      }
    }
  }
}

function textOf(e: PageElement): string {
  return e.events
    .map((x) => x.text ?? '')
    .join('')
    .trim();
}

function short(t: string): string {
  return t.length > 14 ? `${t.slice(0, 14)}…` : t;
}

/**
 * 要素の画面表示用の名前。all を渡すと、検索用の見えない文字が重なっている画像を「文字の画像「…」」と表示する
 * (Office は、効果付きの文字を画像にし、その上に見えない文字を重ねる)
 */
export function elementLabel(e: PageElement, all?: readonly PageElement[]): string {
  switch (e.kind) {
    case 'image': {
      const overlay = all
        ?.filter((x) => x.overlayOf === e.id)
        .map(textOf)
        .join('');
      if (overlay) return `文字の画像「${short(overlay)}」`;
      const p = e.events[0].pixels;
      return p ? `画像(${p.width}×${p.height}px)` : '画像';
    }
    case 'text': {
      const t = textOf(e);
      return t ? `文字「${short(t)}」` : '文字';
    }
    case 'path':
      return e.events.length > 1 ? `図形(${e.events.length} 個)` : '図形';
    case 'shading':
      return 'グラデーション';
    case 'group':
      return 'グループ';
    case 'mixed':
      return `まとまり(${[...new Set(e.events.map((x) => ({ image: '画像', text: '文字', path: '図形', shading: 'グラデーション', group: 'グループ' })[x.kind]))].join('・')})`;
  }
}

