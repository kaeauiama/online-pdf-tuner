// 誤植修正(S1・試験的): PDF の中の文字を、同じフォントの字形で同じ字数だけ置き換える。
//
// 安全に扱えるケースに限る(D-012 / spec 01 注記 A):
//  - 置き換える字が、そのフォント(サブセット)の中に既にある
//  - 字幅が同じ(後ろの文字の位置がずれない)
//  - フォントの埋め込みの許諾が「編集可」(fsType)。プレビューと印刷のみのフォントは直さない
// 白で隠して上に書く方式は採らない(下の誤字が残るため)。
// 制限: 1 つの文字表示命令(Tj / TJ)の中で見つかる文字列だけを扱う。フォーム XObject の中の文字は対象外。
import { PDFDict, PDFName, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { loadFontForEdit, type FontForEdit } from '../pdf/fonts.ts';
import { lexContent, name as opName, type ContentOp, type Operand } from '../pdf/lexer.ts';
import { serializeOp, spliceAll } from '../pdf/serialize.ts';
import { pageContentBytes } from '../print/structure.ts';

export type TypoReason =
  | 'TYPO_FONT_UNSUPPORTED'
  | 'TYPO_FONT_LICENSE'
  | 'TYPO_FONT_LICENSE_UNKNOWN'
  | 'TYPO_GLYPH_MISSING'
  | 'TYPO_WIDTH_MISMATCH';

export interface GlyphPos {
  /** オペランドの位置: Tj なら [0]、TJ なら [0, 配列内の位置]、" なら [2] */
  readonly path: readonly number[];
  /** 文字列の中で何番目のコードか */
  readonly codeIndex: number;
}

export interface TypoMatch {
  readonly pageIndex: number;
  /** 前後の文字(表示用) */
  readonly before: string;
  readonly after: string;
  readonly fontName: string;
  readonly fixable: boolean;
  readonly reason?: TypoReason;
  readonly detail?: string;
  readonly opIndex: number;
  readonly glyphs: readonly GlyphPos[];
  /** 置き換え後のコード(fixable のときのみ) */
  readonly newCodes: readonly number[];
}

export const TYPO_MESSAGES: Record<TypoReason, (m: TypoMatch) => string> = {
  TYPO_FONT_UNSUPPORTED: (m) => `フォント「${m.fontName}」は、この機能に対応していない形式です(${m.detail ?? ''})。元のファイルで直してください。`,
  TYPO_FONT_LICENSE: (m) =>
    `フォント「${m.fontName}」は、埋め込んだ文書の編集を許可していません(プレビューと印刷のみ)。ライセンスに従い、ここでは直しません。元のファイルで直してください。`,
  TYPO_FONT_LICENSE_UNKNOWN: (m) => `フォント「${m.fontName}」の埋め込みの許諾が確認できないため、直しません。元のファイルで直してください。`,
  TYPO_GLYPH_MISSING: (m) =>
    `「${m.detail}」は、この PDF に埋め込まれた「${m.fontName}」に含まれていません(PDF には、使った字だけが埋め込まれています)。元のファイルで直してください。`,
  TYPO_WIDTH_MISMATCH: () => '文字の幅が違うため、置き換えると後ろの文字と重なったり、すき間ができたりします。元のファイルで直してください。',
};

const CONTEXT_CHARS = 8;

interface Glyph extends GlyphPos {
  readonly code: number;
  readonly text: string;
}

interface Run {
  readonly opIndex: number;
  readonly font: FontForEdit;
  readonly glyphs: readonly Glyph[];
}

function stringOperands(op: ContentOp): { path: number[]; bytes: Uint8Array }[] {
  const o = op.operands;
  const str = (x: Operand | undefined) => (x?.type === 'string' ? x.bytes : undefined);
  if (op.op === 'Tj' || op.op === "'") {
    const b = str(o[0]);
    return b ? [{ path: [0], bytes: b }] : [];
  }
  if (op.op === '"') {
    const b = str(o[2]);
    return b ? [{ path: [2], bytes: b }] : [];
  }
  if (op.op === 'TJ' && o[0]?.type === 'array') {
    return o[0].items.flatMap((item, i) => (item.type === 'string' ? [{ path: [0, i], bytes: item.bytes }] : []));
  }
  return [];
}

function pageFonts(doc: PDFDocument, page: PDFPage): Map<string, FontForEdit> {
  const fonts = new Map<string, FontForEdit>();
  const dict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!dict) return fonts;
  for (const [key, ref] of dict.entries()) {
    const f = loadFontForEdit(doc, key.decodeText(), ref);
    if (f) fonts.set(key.decodeText(), f);
  }
  return fonts;
}

/** ページの文字表示命令を、フォントと字形の並びとして取り出す */
export function textRuns(doc: PDFDocument, page: PDFPage): { runs: Run[]; ops: ContentOp[]; content: Uint8Array } {
  const content = pageContentBytes(doc, page);
  const ops = lexContent(content);
  const fonts = pageFonts(doc, page);
  const runs: Run[] = [];
  let font: FontForEdit | undefined;
  const stack: (FontForEdit | undefined)[] = [];
  ops.forEach((op, opIndex) => {
    if (op.op === 'q') stack.push(font);
    else if (op.op === 'Q') font = stack.pop();
    else if (op.op === 'Tf') font = fonts.get(opName(op.operands[0]) ?? '');
    else if (font && (op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"')) {
      const glyphs: Glyph[] = [];
      for (const s of stringOperands(op)) {
        for (let i = 0; i + font.codeBytes <= s.bytes.length; i += font.codeBytes) {
          const code = font.codeBytes === 2 ? (s.bytes[i] << 8) | s.bytes[i + 1] : s.bytes[i];
          glyphs.push({ path: s.path, codeIndex: i / font.codeBytes, code, text: font.toUnicode.get(code) ?? '�' });
        }
      }
      if (glyphs.length > 0) runs.push({ opIndex, font, glyphs });
    }
  });
  return { runs, ops, content };
}

/** find を replace に置き換えられる箇所を探す。find と replace は同じ字数であること */
export function findTypos(doc: PDFDocument, pageIndexes: readonly number[], find: string, replace: string): TypoMatch[] {
  const findChars = Array.from(find);
  const replaceChars = Array.from(replace);
  if (findChars.length === 0 || findChars.length !== replaceChars.length) return [];
  const matches: TypoMatch[] = [];

  for (const pageIndex of pageIndexes) {
    const { runs } = textRuns(doc, doc.getPage(pageIndex));
    for (const run of runs) {
      // 1 字形 = 1 文字の並びとして照合する(合字など 1 字形が複数文字のものは区切りとして扱う)
      const chars = run.glyphs.map((g) => (Array.from(g.text).length === 1 ? g.text : '￿'));
      for (let start = 0; start + findChars.length <= chars.length; start++) {
        if (!findChars.every((c, k) => chars[start + k] === c)) continue;
        const glyphs = run.glyphs.slice(start, start + findChars.length);
        const font = run.font;
        const base = {
          pageIndex,
          before: chars.slice(Math.max(0, start - CONTEXT_CHARS), start).join('').replaceAll('￿', '…'),
          after: chars.slice(start + findChars.length, start + findChars.length + CONTEXT_CHARS).join('').replaceAll('￿', '…'),
          fontName: font.name,
          opIndex: run.opIndex,
          glyphs: glyphs.map(({ path, codeIndex }) => ({ path, codeIndex })),
        };
        const reject = (reason: TypoReason, detail?: string): TypoMatch => ({ ...base, fixable: false, reason, detail, newCodes: [] });

        if (font.unsupported) {
          matches.push(reject('TYPO_FONT_UNSUPPORTED', font.unsupported));
        } else if (font.permission === 'preview-print' || font.permission === 'restricted') {
          matches.push(reject('TYPO_FONT_LICENSE'));
        } else if (font.permission === 'unknown') {
          matches.push(reject('TYPO_FONT_LICENSE_UNKNOWN'));
        } else {
          const newCodes = replaceChars.map((c, k) => (c === findChars[k] ? glyphs[k].code : font.fromUnicode.get(c)));
          const missing = replaceChars.filter((_, k) => newCodes[k] === undefined);
          if (missing.length > 0) {
            matches.push(reject('TYPO_GLYPH_MISSING', [...new Set(missing)].join('')));
          } else if (newCodes.some((c, k) => Math.abs(font.widthOf(c!) - font.widthOf(glyphs[k].code)) > 0.5)) {
            matches.push(reject('TYPO_WIDTH_MISMATCH'));
          } else {
            matches.push({ ...base, fixable: true, newCodes: newCodes as number[] });
          }
        }
        start += findChars.length - 1; // 重ならないように進める
      }
    }
  }
  return matches;
}

function operandAt(op: ContentOp, path: readonly number[]): Extract<Operand, { type: 'string' }> | undefined {
  let o: Operand | undefined = op.operands[path[0]];
  if (path.length > 1 && o?.type === 'array') o = o.items[path[1]];
  return o?.type === 'string' ? o : undefined;
}

/** findTypos の結果(fixable のもの)を PDF に反映する。doc を書き換える */
export function applyTypos(doc: PDFDocument, matches: readonly TypoMatch[]): number {
  let applied = 0;
  const byPage = new Map<number, TypoMatch[]>();
  for (const m of matches) if (m.fixable) byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), m]);

  for (const [pageIndex, pageMatches] of byPage) {
    const page = doc.getPage(pageIndex);
    const { ops, content, runs } = textRuns(doc, page);
    const fontByOp = new Map(runs.map((r) => [r.opIndex, r.font]));
    const touched = new Set<number>();
    for (const m of pageMatches) {
      const op = ops[m.opIndex];
      const font = fontByOp.get(m.opIndex);
      if (!op || !font) continue;
      m.glyphs.forEach((g, k) => {
        const s = operandAt(op, g.path);
        if (!s) return;
        const code = m.newCodes[k];
        const at = g.codeIndex * font.codeBytes;
        if (font.codeBytes === 2) {
          s.bytes[at] = code >> 8;
          s.bytes[at + 1] = code & 0xff;
        } else {
          s.bytes[at] = code;
        }
      });
      touched.add(m.opIndex);
      applied++;
    }
    const edits = [...touched].map((i) => ({ start: ops[i].start, end: ops[i].end, text: serializeOp(ops[i]) }));
    const next = spliceAll(content, edits);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  }
  return applied;
}
