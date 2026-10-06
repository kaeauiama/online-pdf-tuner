// 誤植修正(S1・試験的): PDF の中の文字を、同じフォントの字形で同じ字数だけ置き換える。
//
// 安全に扱えるケースに限る(D-012 / spec 01 注記 A):
//  - 置き換える字が、そのフォント(サブセット)の中にある。ない字は、PC に同じフォントがあればそこから補う(D-027)
//  - 字幅が同じ(後ろの文字の位置がずれない)
//  - フォントの埋め込みの許諾が「編集可」(fsType)。プレビューと印刷のみのフォントは直さない
// 白で隠して上に書く方式は採らない(下の誤字が残るため)。
// 制限: 1 つの文字表示命令(Tj / TJ)の中で見つかる文字列だけを扱う。フォーム XObject の中の文字は対象外。
import { PDFDict, PDFName, type PDFDocument, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import { loadFontForEdit, type FontForEdit } from '../pdf/fonts.ts';
import { lexContent, name as opName, num, type ContentOp, type Operand } from '../pdf/lexer.ts';
import { serializeOp, serializeOperand, spliceAll } from '../pdf/serialize.ts';
import { pageContentBytes } from '../print/structure.ts';
import { normalizeFontName, type LocalFont } from './localFonts.ts';

export type TypoReason =
  | 'TYPO_FONT_UNSUPPORTED'
  | 'TYPO_FONT_LICENSE'
  | 'TYPO_FONT_LICENSE_UNKNOWN'
  | 'TYPO_GLYPH_MISSING'
  | 'TYPO_WIDTH_MISMATCH'
  | 'TYPO_LOCAL_FONT_NOT_FOUND'
  | 'TYPO_LOCAL_FONT_LICENSE';

export interface GlyphPos {
  /** オペランドの位置: Tj なら [0]、TJ なら [0, 配列内の位置]、" なら [2] */
  readonly path: readonly number[];
  /** 文字列の中で何番目のコードか */
  readonly codeIndex: number;
}

/** 置き換え後の字: 同じフォントのコード、または PC のフォントから補う字 */
export type Replacement = { readonly code: number } | { readonly local: string };

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
  /** 置き換え後の字(fixable のときのみ。glyphs と同じ順) */
  readonly replacements: readonly Replacement[];
  /** PC のフォントから補うとき、そのフォント(名前の比較用のキー) */
  readonly localKey?: string;
}

export const TYPO_MESSAGES: Record<TypoReason, (m: TypoMatch) => string> = {
  TYPO_FONT_UNSUPPORTED: (m) => `フォント「${m.fontName}」は、この機能に対応していない形式です(${m.detail ?? ''})。元のファイルで直してください。`,
  TYPO_FONT_LICENSE: (m) =>
    `フォント「${m.fontName}」は、埋め込んだ文書の編集を許可していません(プレビューと印刷のみ)。ライセンスに従い、ここでは直しません。元のファイルで直してください。`,
  TYPO_FONT_LICENSE_UNKNOWN: (m) =>
    `フォント「${m.fontName}」の埋め込みの許諾が確認できないため、直しません。PC に同じフォントがあれば、「PC のフォントで補って探し直す」で許諾を確認できます。`,
  TYPO_GLYPH_MISSING: (m) =>
    `「${m.detail}」は、この PDF に埋め込まれた「${m.fontName}」に含まれていません(PDF には、使った字だけが埋め込まれています)。PC に同じフォントがあれば、「PC のフォントで補って探し直す」で直せることがあります。`,
  TYPO_WIDTH_MISMATCH: () => '文字の幅が違うため、置き換えると後ろの文字と重なったり、すき間ができたりします。元のファイルで直してください。',
  TYPO_LOCAL_FONT_NOT_FOUND: (m) => `「${m.detail}」が足りませんが、この PC に「${m.fontName}」が見つかりませんでした。元のファイルで直してください。`,
  TYPO_LOCAL_FONT_LICENSE: (m) =>
    `PC の「${m.fontName}」は、文書の編集のための埋め込みを許可していません。ライセンスに従い、ここでは補いません。元のファイルで直してください。`,
};

const CONTEXT_CHARS = 8;

interface Glyph extends GlyphPos {
  readonly code: number;
  readonly text: string;
}

interface Run {
  readonly opIndex: number;
  readonly font: FontForEdit;
  /** そのときの Tf の大きさ */
  readonly fontSize: number;
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
  let fontSize = 0;
  const stack: { font: FontForEdit | undefined; fontSize: number }[] = [];
  ops.forEach((op, opIndex) => {
    if (op.op === 'q') stack.push({ font, fontSize });
    else if (op.op === 'Q') ({ font, fontSize } = stack.pop() ?? { font, fontSize });
    else if (op.op === 'Tf') {
      font = fonts.get(opName(op.operands[0]) ?? '');
      fontSize = num(op.operands[1]);
    } else if (font && (op.op === 'Tj' || op.op === 'TJ' || op.op === "'" || op.op === '"')) {
      const glyphs: Glyph[] = [];
      for (const s of stringOperands(op)) {
        for (let i = 0; i + font.codeBytes <= s.bytes.length; i += font.codeBytes) {
          const code = font.codeBytes === 2 ? (s.bytes[i] << 8) | s.bytes[i + 1] : s.bytes[i];
          glyphs.push({ path: s.path, codeIndex: i / font.codeBytes, code, text: font.toUnicode.get(code) ?? '�' });
        }
      }
      if (glyphs.length > 0) runs.push({ opIndex, font, fontSize, glyphs });
    }
  });
  return { runs, ops, content };
}

/** PC のフォントを、埋め込みのフォント名から探す関数(見つからなければ undefined) */
export type LocalFontLookup = (fontName: string) => LocalFont | undefined;

/** find を replace に置き換えられる箇所を探す。find と replace は同じ字数であること */
export function findTypos(
  doc: PDFDocument,
  pageIndexes: readonly number[],
  find: string,
  replace: string,
  localFonts?: LocalFontLookup,
): TypoMatch[] {
  const findChars = Array.from(find);
  const replaceChars = Array.from(replace);
  if (findChars.length === 0 || findChars.length !== replaceChars.length) return [];
  const matches: TypoMatch[] = [];

  for (const pageIndex of pageIndexes) {
    const { runs, ops } = textRuns(doc, doc.getPage(pageIndex));
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
        const reject = (reason: TypoReason, detail?: string): TypoMatch => ({ ...base, fixable: false, reason, detail, replacements: [] });
        matches.push(judge(font, glyphs, findChars, replaceChars, ops[run.opIndex].op, reject, base, localFonts));
        start += findChars.length - 1; // 重ならないように進める
      }
    }
  }
  return matches;
}

function judge(
  font: FontForEdit,
  glyphs: readonly Glyph[],
  findChars: readonly string[],
  replaceChars: readonly string[],
  op: string,
  reject: (reason: TypoReason, detail?: string) => TypoMatch,
  base: Omit<TypoMatch, 'fixable' | 'replacements'>,
  localFonts?: LocalFontLookup,
): TypoMatch {
  if (font.unsupported) return reject('TYPO_FONT_UNSUPPORTED', font.unsupported);
  // 埋め込みのサブセットから許諾(OS/2)が失われていることがある。PC に同じフォントがあれば、その許諾を使う
  const pc = localFonts?.(font.name);
  const permission = font.permission === 'unknown' && pc && pc.permission !== 'unknown' ? pc.permission : font.permission;
  if (permission === 'preview-print' || permission === 'restricted') return reject('TYPO_FONT_LICENSE');
  if (permission === 'unknown') return reject('TYPO_FONT_LICENSE_UNKNOWN');

  const codes = replaceChars.map((c, k) => (c === findChars[k] ? glyphs[k].code : font.fromUnicode.get(c)));
  const missing = [...new Set(replaceChars.filter((_, k) => codes[k] === undefined))];
  const widthDiffers = (w: number, k: number) => Math.abs(w - font.widthOf(glyphs[k].code)) > 0.5;

  if (missing.length === 0) {
    if (codes.some((c, k) => widthDiffers(font.widthOf(c!), k))) return reject('TYPO_WIDTH_MISMATCH');
    return { ...base, fixable: true, replacements: codes.map((c) => ({ code: c! })) };
  }

  // 足りない字を、PC の同じフォントから補う(D-027)
  if (!localFonts) return reject('TYPO_GLYPH_MISSING', missing.join(''));
  const local = localFonts(font.name);
  if (!local) return reject('TYPO_LOCAL_FONT_NOT_FOUND', missing.join(''));
  if (local.permission !== 'editable') return reject('TYPO_LOCAL_FONT_LICENSE');
  const stillMissing = missing.filter((c) => !local.hasChar(c));
  if (stillMissing.length > 0) return reject('TYPO_GLYPH_MISSING', stillMissing.join(''));
  if (op !== 'Tj' && op !== 'TJ') return reject('TYPO_FONT_UNSUPPORTED', 'この書き方の文字には、PC のフォントからの補いが未対応');
  const replacements: Replacement[] = replaceChars.map((c, k) => (codes[k] !== undefined ? { code: codes[k]! } : { local: c }));
  const differs = replacements.some((r, k) => widthDiffers('code' in r ? font.widthOf(r.code) : local.widthOf(r.local), k));
  if (differs) return reject('TYPO_WIDTH_MISMATCH');
  return { ...base, fixable: true, replacements, localKey: normalizeFontName(font.name) };
}

function operandAt(op: ContentOp, path: readonly number[]): Extract<Operand, { type: 'string' }> | undefined {
  let o: Operand | undefined = op.operands[path[0]];
  if (path.length > 1 && o?.type === 'array') o = o.items[path[1]];
  return o?.type === 'string' ? o : undefined;
}

function writeCode(bytes: Uint8Array, at: number, code: number, codeBytes: number): void {
  if (codeBytes === 2) {
    bytes[at] = code >> 8;
    bytes[at + 1] = code & 0xff;
  } else {
    bytes[at] = code;
  }
}

/**
 * 字の一部を PC のフォントで描くように、文字表示の命令を書き直す。
 * 元のフォントで描く部分と PC のフォントで描く部分に分け、その間だけフォントを切り替える(字幅は同じなので位置はずれない)
 */
function rewriteWithLocal(
  op: ContentOp,
  font: FontForEdit,
  fontResource: string,
  fontSize: number,
  local: Map<string, string>,
  localResource: string,
  localFont: PDFFont,
): string {
  const items: Operand[] = op.op === 'TJ' && op.operands[0]?.type === 'array' ? op.operands[0].items : [op.operands[0]];
  type Piece = { kind: 'orig'; bytes: number[] } | { kind: 'local'; bytes: number[] } | { kind: 'kern'; value: Operand };
  const pieces: Piece[] = [];
  items.forEach((item, i) => {
    if (item.type !== 'string') {
      pieces.push({ kind: 'kern', value: item });
      return;
    }
    for (let at = 0; at + font.codeBytes <= item.bytes.length; at += font.codeBytes) {
      const char = local.get(`${i}:${at / font.codeBytes}`);
      if (char !== undefined) {
        pieces.push({ kind: 'local', bytes: [...localFont.encodeText(char).asBytes()] });
      } else {
        pieces.push({ kind: 'orig', bytes: [...item.bytes.subarray(at, at + font.codeBytes)] });
      }
    }
  });

  const out: string[] = [];
  let current: 'orig' | 'local' = 'orig';
  let array: Operand[] = [];
  const flush = () => {
    if (array.length > 0) out.push(`${serializeOperand({ type: 'array', items: array })} TJ`);
    array = [];
  };
  const size = serializeOperand({ type: 'number', value: fontSize });
  for (const p of pieces) {
    if (p.kind === 'kern') {
      array.push(p.value);
      continue;
    }
    if (p.kind !== current) {
      flush();
      out.push(p.kind === 'local' ? `/${localResource} ${size} Tf` : `/${fontResource} ${size} Tf`);
      current = p.kind;
    }
    const last = array[array.length - 1];
    if (last?.type === 'string') array[array.length - 1] = { type: 'string', bytes: Uint8Array.from([...last.bytes, ...p.bytes]), hex: true };
    else array.push({ type: 'string', bytes: Uint8Array.from(p.bytes), hex: true });
  }
  flush();
  if (current === 'local') out.push(`/${fontResource} ${size} Tf`);
  return out.join(' ');
}

/**
 * findTypos の結果(fixable のもの)を PDF に反映する。doc を書き換える。
 * PC のフォントから補う箇所があるときは、localFonts に同じ関数を渡すこと
 */
export async function applyTypos(doc: PDFDocument, matches: readonly TypoMatch[], localFonts?: LocalFontLookup): Promise<number> {
  let applied = 0;
  const byPage = new Map<number, TypoMatch[]>();
  for (const m of matches) if (m.fixable) byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), m]);
  const embedded = new Map<string, PDFFont>();

  for (const [pageIndex, pageMatches] of byPage) {
    const page = doc.getPage(pageIndex);
    const { ops, content, runs } = textRuns(doc, page);
    const runByOp = new Map(runs.map((r) => [r.opIndex, r]));
    const fontResourceOf = new Map<number, string>();
    {
      let current = '';
      const stack: string[] = [];
      ops.forEach((op, i) => {
        if (op.op === 'q') stack.push(current);
        else if (op.op === 'Q') current = stack.pop() ?? current;
        else if (op.op === 'Tf') current = opName(op.operands[0]) ?? '';
        fontResourceOf.set(i, current);
      });
    }
    const edits = new Map<number, string>();
    const localByOp = new Map<number, { chars: Map<string, string>; key: string }>();

    for (const m of pageMatches) {
      const op = ops[m.opIndex];
      const run = runByOp.get(m.opIndex);
      if (!op || !run) continue;
      m.glyphs.forEach((g, k) => {
        const r = m.replacements[k];
        if ('code' in r) {
          const s = operandAt(op, g.path);
          if (s) writeCode(s.bytes, g.codeIndex * run.font.codeBytes, r.code, run.font.codeBytes);
        } else {
          const entry = localByOp.get(m.opIndex) ?? { chars: new Map(), key: m.localKey! };
          entry.chars.set(`${g.path[1] ?? 0}:${g.codeIndex}`, r.local);
          localByOp.set(m.opIndex, entry);
        }
      });
      edits.set(m.opIndex, serializeOp(op));
      applied++;
    }

    // PC のフォントから補う命令を書き直す
    for (const [opIndex, { chars, key }] of localByOp) {
      const run = runByOp.get(opIndex)!;
      const local = localFonts?.(run.font.name);
      if (!local) throw new Error(`local font not available: ${key}`);
      let pdfFont = embedded.get(key);
      if (!pdfFont) {
        const { default: fontkit } = await import('@cantoo/fontkit');
        doc.registerFontkit(fontkit);
        pdfFont = await doc.embedFont(local.bytes, { subset: true, ...(local.isCollection ? { postscriptName: local.postscriptName } : {}) });
        embedded.set(key, pdfFont);
      }
      const resource = page.node.newFontDictionary('FTypoLocal', pdfFont.ref).decodeText();
      edits.set(opIndex, rewriteWithLocal(ops[opIndex], run.font, fontResourceOf.get(opIndex) ?? '', run.fontSize, chars, resource, pdfFont));
    }

    const next = spliceAll(
      content,
      [...edits].map(([i, text]) => ({ start: ops[i].start, end: ops[i].end, text })),
    );
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
  }
  return applied;
}
