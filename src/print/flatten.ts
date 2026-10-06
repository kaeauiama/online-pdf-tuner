// 効果の焼き込み(透明効果の分割統合)。
// ページを「文字以外」と「文字だけ」の 2 つの層に分け、文字以外を高解像度の画像にして下に敷き、
// 文字はベクターのまま上に重ねる(文字がぼやけず、黒い文字が 4 色の黒に変わらない)。
//
// 文字は、そのときの不透明度と描画モード(Tr)で 3 通りに分ける:
//  - 不透明な文字 → 文字の層に残す(ベクター)
//  - 完全に透明な文字(Office が検索用に重ねる「見えない文字」など)→ 文字の層に、描画モード 3(見えない文字)として残す
//  - 半透明・ソフトマスク・描画モード付きの文字 → 効果ごと画像の層に焼き込む
// 文字の層には透明の指定(gs)を一切残さない。
//
// この関数群はコンテンツストリームの書き換え(純粋関数)。描画は flattenRender.ts(ブラウザ)で行う。
import { lexContent, name as opName, num } from '../pdf/lexer.ts';
import { serializeOp, spliceAll } from '../pdf/serialize.ts';

const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const PATH_PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);
const FILL_MODES = new Set([0, 2, 4, 6]);
const STROKE_MODES = new Set([1, 2, 5, 6]);

/** ExtGState の、透明に関わる値(指定がない項目は undefined) */
export interface GsInfo {
  readonly fillAlpha?: number;
  readonly strokeAlpha?: number;
  /** ソフトマスクを設定する(true)/ 解除する(false) */
  readonly softMask?: boolean;
  /** Normal / Compatible 以外の描画モードを設定する(true)/ Normal に戻す(false) */
  readonly blend?: boolean;
}

interface State {
  fillAlpha: number;
  strokeAlpha: number;
  softMask: boolean;
  blend: boolean;
  tr: number;
}

export interface TextLayers {
  /** 文字を除いたコンテンツ(画像にして下に敷く)。効果付きの文字はここに残る */
  readonly noText: Uint8Array;
  /** 文字だけを残したコンテンツ(上に重ねる)。図形の塗りは「塗らずに終える」(n)に変え、画像・グラデーション・透明の指定は除く */
  readonly textOnly: Uint8Array;
  /** 文字の層に残した文字の命令の数(見えない文字を含む) */
  readonly vectorText: number;
  /** 見えない文字(描画モード 3)に置き換えた、完全に透明な文字の命令の数 */
  readonly invisibleText: number;
  /** 効果ごと画像に焼き込んだ文字の命令の数 */
  readonly rasterizedText: number;
  /** XObject(画像・フォーム)の描画の数。フォームの中の文字は、文字の層に残らず画像になる */
  readonly xobjects: number;
}

export function splitTextLayers(content: Uint8Array, extGState: (name: string) => GsInfo | undefined = () => undefined): TextLayers {
  const ops = lexContent(content);
  const noTextEdits: { start: number; end: number; text: string }[] = [];
  const textOnlyEdits: { start: number; end: number; text: string }[] = [];
  let vectorText = 0;
  let invisibleText = 0;
  let rasterizedText = 0;
  let xobjects = 0;
  let state: State = { fillAlpha: 1, strokeAlpha: 1, softMask: false, blend: false, tr: 0 };
  const stack: State[] = [];

  for (const op of ops) {
    switch (op.op) {
      case 'q':
        stack.push({ ...state });
        continue;
      case 'Q':
        state = stack.pop() ?? state;
        continue;
      case 'Tr':
        state.tr = num(op.operands[0]);
        continue;
      case 'gs': {
        const info = extGState(opName(op.operands[0]) ?? '');
        if (info?.fillAlpha !== undefined) state.fillAlpha = info.fillAlpha;
        if (info?.strokeAlpha !== undefined) state.strokeAlpha = info.strokeAlpha;
        if (info?.softMask !== undefined) state.softMask = info.softMask;
        if (info?.blend !== undefined) state.blend = info.blend;
        textOnlyEdits.push({ start: op.start, end: op.end, text: '' });
        continue;
      }
    }

    if (TEXT_SHOW.has(op.op)) {
      const { tr } = state;
      const removeFromNoText = () =>
        // ' と " は改行してから表示する命令。文字を消しても、行送りだけは残す
        noTextEdits.push({ start: op.start, end: op.end, text: op.op === 'Tj' || op.op === 'TJ' ? '' : 'T*' });
      if (tr === 3 || tr === 7) {
        // もともと見えない文字(7 はクリップ): 描画モードを明示して文字の層に残す
        vectorText++;
        removeFromNoText();
        textOnlyEdits.push({ start: op.start, end: op.end, text: `${tr} Tr ${serializeOp(op)}` });
        continue;
      }
      const fill = FILL_MODES.has(tr) ? state.fillAlpha : 0;
      const stroke = STROKE_MODES.has(tr) ? state.strokeAlpha : 0;
      if (fill <= 0 && stroke <= 0) {
        // 完全に透明 = 見えない文字。透明を使わない「描画モード 3」に置き換える(検索・コピー用の文字は残る)
        vectorText++;
        invisibleText++;
        removeFromNoText();
        textOnlyEdits.push({ start: op.start, end: op.end, text: `3 Tr ${serializeOp(op)}` });
      } else if ((fill > 0 && fill < 1) || (stroke > 0 && stroke < 1) || state.softMask || state.blend) {
        // 半透明などの効果付き: 効果ごと画像に焼き込む
        rasterizedText++;
        textOnlyEdits.push({ start: op.start, end: op.end, text: '' });
      } else {
        vectorText++;
        removeFromNoText();
        textOnlyEdits.push({ start: op.start, end: op.end, text: `${tr} Tr ${serializeOp(op)}` });
      }
    } else if (PATH_PAINT.has(op.op)) {
      // クリップ(W n)の効果は残したまま、塗りだけをやめる
      textOnlyEdits.push({ start: op.start, end: op.end, text: 'n' });
    } else if (op.op === 'sh' || op.op === 'BI') {
      textOnlyEdits.push({ start: op.start, end: op.end, text: '' });
    } else if (op.op === 'Do') {
      xobjects++;
      textOnlyEdits.push({ start: op.start, end: op.end, text: '' });
    }
  }
  return {
    noText: spliceAll(content, noTextEdits),
    textOnly: spliceAll(content, textOnlyEdits),
    vectorText,
    invisibleText,
    rasterizedText,
    xobjects,
  };
}

/** 描画する解像度の上限(画素数)。これを超えるときは解像度を下げる(ブラウザの canvas の上限とメモリのため) */
export const MAX_FLATTEN_PIXELS = 80_000_000;

/** 解像度(ppi)と、ページの大きさ(pt)から、描画する倍率を決める。上限を超えるなら下げる */
export function flattenScale(widthPt: number, heightPt: number, dpi: number): { scale: number; dpi: number } {
  let scale = dpi / 72;
  const pixels = widthPt * scale * heightPt * scale;
  if (pixels > MAX_FLATTEN_PIXELS) scale *= Math.sqrt(MAX_FLATTEN_PIXELS / pixels);
  return { scale, dpi: Math.round(scale * 72) };
}
