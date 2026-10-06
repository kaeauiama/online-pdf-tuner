// ページ内の編集: 文字表示の命令(Tj / TJ / ' / ")1 つ分の文字列を書き換える(「ページの中」タブ)。設計: docs/spec/03-page-editor.md
//
// 誤植修正(S1)と同じ安全の条件に従う(D-022 / D-027):
//  - フォントの埋め込みの許諾が「編集可」(fsType)のときだけ書き換える
//  - 字は、埋め込まれたフォント(サブセット)の中にあるものを使う。ない字は、PC に同じフォントがあればそこから補う
// 誤植修正との違いは、字数・字幅が変わってもよいこと。命令の後ろの文字の位置は自動では詰め直されないため、
// 幅が変わるときは重なり・すき間が出うることを警告する。変えた部分の字間の調整(TJ の数値)は外れる。
// 変えていない先頭と末尾の字は、字間の調整も含めて元のまま残す。
import type { PDFDocument, PDFFont, PDFPage } from '@cantoo/pdf-lib';
import type { FontForEdit } from '../pdf/fonts.ts';
import type { ContentOp, Operand } from '../pdf/lexer.ts';
import { serializeOperand, type Splice } from '../pdf/serialize.ts';
import { normalizeFontName, type LocalFont } from '../typo/localFonts.ts';
import { textRuns, writePieces, type LocalFontLookup, type Piece } from '../typo/typo.ts';

export type TextEditCode =
  | 'TEXT_NOT_EDITABLE'
  | 'TEXT_FONT_UNSUPPORTED'
  | 'TEXT_FONT_LICENSE'
  | 'TEXT_FONT_LICENSE_UNKNOWN'
  | 'TEXT_GLYPH_MISSING'
  | 'TEXT_LOCAL_FONT_NOT_FOUND'
  | 'TEXT_LOCAL_FONT_LICENSE';

export const TEXT_EDIT_MESSAGES: Record<TextEditCode, (font: string, detail?: string) => string> = {
  TEXT_NOT_EDITABLE: () => 'この文字は、書き換えに対応していない書き方で記録されています。元のファイルで直してください。',
  TEXT_FONT_UNSUPPORTED: (font, detail) => `フォント「${font}」は、文字の書き換えに対応していない形式です(${detail ?? ''})。元のファイルで直してください。`,
  TEXT_FONT_LICENSE: (font) =>
    `フォント「${font}」は、埋め込んだ文書の編集を許可していません(プレビューと印刷のみ)。ライセンスに従い、ここでは書き換えません。元のファイルで直してください。`,
  TEXT_FONT_LICENSE_UNKNOWN: (font) =>
    `フォント「${font}」の埋め込みの許諾が確認できないため、書き換えません。PC に同じフォントがあれば、「PC のフォントで補う」で許諾を確認できます。`,
  TEXT_GLYPH_MISSING: (font, detail) =>
    `「${detail}」は、この PDF に埋め込まれた「${font}」に含まれていません(PDF には、使った字だけが埋め込まれています)。PC に同じフォントがあれば、「PC のフォントで補う」で使えることがあります。`,
  TEXT_LOCAL_FONT_NOT_FOUND: (font, detail) => `「${detail}」が足りませんが、この PC に「${font}」が見つかりませんでした。元のファイルで直してください。`,
  TEXT_LOCAL_FONT_LICENSE: (font) => `PC の「${font}」は、文書の編集のための埋め込みを許可していません。ライセンスに従い、ここでは補いません。`,
};

/** 書き換えられる文字表示の命令 1 つ分 */
export interface TextLine {
  readonly opIndex: number;
  readonly text: string;
  readonly fontName: string;
}

export type TextPlan =
  | {
      readonly ok: true;
      /** 書き換え後の幅 ÷ 元の幅(字間の調整を含む、Tc / Tw は除く) */
      readonly widthRatio: number;
      /** 変えた部分にあった字間の調整を外したか */
      readonly kerningDropped: boolean;
      /** PC のフォントから字を補うか */
      readonly usesLocal: boolean;
    }
  | { readonly ok: false; readonly code: TextEditCode; readonly fontName: string; readonly detail?: string };

type Token = { kind: 'glyph'; bytes: number[]; text: string; width: number } | { kind: 'kern'; value: Operand };
type NewPiece = { kind: 'orig'; bytes: number[] } | { kind: 'local'; char: string } | { kind: 'kern'; value: Operand };

interface Built {
  readonly pieces: NewPiece[];
  readonly widthRatio: number;
  readonly kerningDropped: boolean;
  readonly local?: LocalFont;
}

type Run = ReturnType<typeof textRuns>['runs'][number];

function tokensOf(op: ContentOp, font: FontForEdit): Token[] {
  const o = op.operands;
  const items: Operand[] =
    op.op === 'TJ' && o[0]?.type === 'array' ? o[0].items : [o[op.op === '"' ? 2 : 0]].filter((x): x is Operand => x !== undefined);
  const tokens: Token[] = [];
  for (const item of items) {
    if (item.type === 'number') {
      tokens.push({ kind: 'kern', value: item });
      continue;
    }
    if (item.type !== 'string') continue;
    for (let i = 0; i + font.codeBytes <= item.bytes.length; i += font.codeBytes) {
      const code = font.codeBytes === 2 ? (item.bytes[i] << 8) | item.bytes[i + 1] : item.bytes[i];
      tokens.push({ kind: 'glyph', bytes: [...item.bytes.subarray(i, i + font.codeBytes)], text: font.toUnicode.get(code) ?? '�', width: font.widthOf(code) });
    }
  }
  return tokens;
}

function emWidth(tokens: readonly (Token | { kind: 'new'; width: number })[]): number {
  let w = 0;
  for (const t of tokens) w += t.kind === 'kern' ? -(t.value.type === 'number' ? t.value.value : 0) : t.width;
  return w / 1000;
}

function build(run: Run, op: ContentOp, newText: string, localFonts?: LocalFontLookup): Built | Extract<TextPlan, { ok: false }> {
  const font = run.font;
  const fail = (code: TextEditCode, detail?: string) => ({ ok: false as const, code, fontName: font.name, detail });
  if (font.unsupported) return fail('TEXT_FONT_UNSUPPORTED', font.unsupported);
  // 埋め込みのサブセットから許諾(OS/2)が失われていることがある。PC に同じフォントがあれば、その許諾を使う
  const pc = localFonts?.(font.name);
  const permission = font.permission === 'unknown' && pc && pc.permission !== 'unknown' ? pc.permission : font.permission;
  if (permission === 'preview-print' || permission === 'restricted') return fail('TEXT_FONT_LICENSE');
  if (permission === 'unknown') return fail('TEXT_FONT_LICENSE_UNKNOWN');

  const tokens = tokensOf(op, font);
  const glyphAt: number[] = [];
  tokens.forEach((t, i) => t.kind === 'glyph' && glyphAt.push(i));
  const glyphs = glyphAt.map((i) => tokens[i] as Extract<Token, { kind: 'glyph' }>);
  const chars = Array.from(newText);

  // 変えていない先頭と末尾の字(字形の単位。合字などは 1 字形 = 複数文字)
  let gp = 0;
  let cp = 0;
  while (gp < glyphs.length) {
    const g = Array.from(glyphs[gp].text);
    if (g.length === 0 || g.some((c, k) => chars[cp + k] !== c)) break;
    gp++;
    cp += g.length;
  }
  let gs = 0;
  let cs = 0;
  while (gs < glyphs.length - gp) {
    const g = Array.from(glyphs[glyphs.length - 1 - gs].text);
    if (g.length === 0 || cp + cs + g.length > chars.length || g.some((c, k) => chars[chars.length - cs - g.length + k] !== c)) break;
    gs++;
    cs += g.length;
  }
  const middle = chars.slice(cp, chars.length - cs);

  // 足りない字は、PC の同じフォントから補う(D-027)
  const missing = [...new Set(middle.filter((c) => font.fromUnicode.get(c) === undefined))];
  let local: LocalFont | undefined;
  if (missing.length > 0) {
    if (!localFonts) return fail('TEXT_GLYPH_MISSING', missing.join(''));
    local = localFonts(font.name);
    if (!local) return fail('TEXT_LOCAL_FONT_NOT_FOUND', missing.join(''));
    if (local.permission !== 'editable') return fail('TEXT_LOCAL_FONT_LICENSE');
    const still = missing.filter((c) => !local!.hasChar(c));
    if (still.length > 0) return fail('TEXT_GLYPH_MISSING', still.join(''));
  }

  const headEnd = gp === 0 ? 0 : glyphAt[gp - 1] + 1;
  const tailStart = gs > 0 ? glyphAt[glyphs.length - gs] : glyphs.length > 0 ? glyphAt[glyphs.length - 1] + 1 : tokens.length;
  const head = tokens.slice(0, Math.min(headEnd, tailStart));
  const dropped = tokens.slice(Math.min(headEnd, tailStart), tailStart);
  const tail = tokens.slice(tailStart);
  const newMiddle: NewPiece[] = middle.map((c) => {
    const code = font.fromUnicode.get(c);
    if (code === undefined) return { kind: 'local', char: c };
    return { kind: 'orig', bytes: font.codeBytes === 2 ? [code >> 8, code & 0xff] : [code] };
  });
  const middleWidth = middle.map((c) => {
    const code = font.fromUnicode.get(c);
    return { kind: 'new' as const, width: code !== undefined ? font.widthOf(code) : local!.widthOf(c) };
  });
  const toPiece = (t: Token): NewPiece => (t.kind === 'kern' ? t : { kind: 'orig', bytes: t.bytes });
  const oldWidth = emWidth(tokens);
  const newWidth = emWidth([...head, ...middleWidth, ...tail]);
  return {
    pieces: [...head.map(toPiece), ...newMiddle, ...tail.map(toPiece)],
    widthRatio: oldWidth > 0 ? newWidth / oldWidth : 1,
    kerningDropped: dropped.some((t) => t.kind === 'kern' && t.value.type === 'number' && t.value.value !== 0),
    local,
  };
}

function runAt(doc: PDFDocument, page: PDFPage, opIndex: number) {
  const { runs, ops } = textRuns(doc, page);
  return { run: runs.find((r) => r.opIndex === opIndex), op: ops[opIndex], ops };
}

/** ページの、書き換えの対象になりうる文字表示の命令(命令の位置 → 文字列) */
export function textLines(doc: PDFDocument, page: PDFPage): Map<number, TextLine> {
  const { runs } = textRuns(doc, page);
  return new Map(runs.map((r) => [r.opIndex, { opIndex: r.opIndex, text: r.glyphs.map((g) => g.text).join(''), fontName: r.font.name }]));
}

/** 書き換えられるかを確かめる(PDF は変えない) */
export function planTextEdit(doc: PDFDocument, page: PDFPage, opIndex: number, newText: string, localFonts?: LocalFontLookup): TextPlan {
  const { run, op } = runAt(doc, page, opIndex);
  if (!run || !op) return { ok: false, code: 'TEXT_NOT_EDITABLE', fontName: '' };
  const built = build(run, op, newText, localFonts);
  if ('ok' in built) return built;
  return { ok: true, widthRatio: built.widthRatio, kerningDropped: built.kerningDropped, usesLocal: !!built.local };
}

/** 書き換え後の命令の、利用者への注意(幅の変化・字間の調整・PC のフォント) */
export function textPlanWarnings(plan: Extract<TextPlan, { ok: true }>): string[] {
  const warnings: string[] = [];
  const pct = Math.round(Math.abs(plan.widthRatio - 1) * 100);
  if (pct >= 1 && plan.widthRatio > 1) warnings.push(`文字の幅が約 ${pct}% 広くなります。同じ行の後ろに文字があると、重なることがあります(行は自動で詰め直されません)。`);
  if (pct >= 1 && plan.widthRatio < 1) warnings.push(`文字の幅が約 ${pct}% 狭くなります。同じ行の後ろに文字があると、すき間ができることがあります。`);
  if (plan.kerningDropped) warnings.push('変えた部分の字間の調整は外れます。');
  if (plan.usesLocal) warnings.push('足りない字は、PC のフォントから補います。');
  return warnings;
}

/**
 * 文字の書き換え(命令の位置 → 新しい文字列)を、コンテンツの置き換えにする。
 * PC のフォントから補う字があれば、そのフォントを doc に埋め込み、page のリソースに加える(doc を書き換える)。
 * 書き換えられないもの(planTextEdit で弾かれるもの)は無視する。
 * 戻り値の位置は、呼ぶ前のページのコンテンツが基準。pdf-lib はリソースを加えるときにコンテンツを q 〜 Q で包むため、
 * コンテンツは呼ぶ前に取り出しておき、書き換えた結果で Contents を置き換えること
 */
export async function textEditSplices(
  doc: PDFDocument,
  page: PDFPage,
  changes: ReadonlyMap<number, string>,
  localFonts?: LocalFontLookup,
): Promise<Splice[]> {
  if (changes.size === 0) return [];
  const { runs, ops } = textRuns(doc, page);
  const embedded = new Map<string, { font: PDFFont; resource: string }>();
  const splices: Splice[] = [];
  for (const [opIndex, text] of changes) {
    const run = runs.find((r) => r.opIndex === opIndex);
    const op = ops[opIndex];
    if (!run || !op) continue;
    const built = build(run, op, text, localFonts);
    if ('ok' in built) continue;
    let localEntry: { font: PDFFont; resource: string } | undefined;
    if (built.local) {
      const key = normalizeFontName(run.font.name);
      localEntry = embedded.get(key);
      if (!localEntry) {
        const { default: fontkit } = await import('@cantoo/fontkit');
        doc.registerFontkit(fontkit);
        const font = await doc.embedFont(built.local.bytes, { subset: true, ...(built.local.isCollection ? { postscriptName: built.local.postscriptName } : {}) });
        localEntry = { font, resource: page.node.newFontDictionary('FEditLocal', font.ref).decodeText() };
        embedded.set(key, localEntry);
      }
    }
    const pieces: Piece[] = built.pieces.map((p) =>
      p.kind === 'local' ? { kind: 'local', bytes: [...localEntry!.font.encodeText(p.char).asBytes()] } : p,
    );
    const shown = writePieces(pieces, run.font.resourceName, run.fontSize, localEntry?.resource ?? '');
    // ' と " は「次の行へ移ってから表示」。表示の部分を TJ に書き換えるので、行の移動と字間の設定を先に書く
    const o = op.operands;
    const prefix =
      op.op === "'" ? 'T* ' : op.op === '"' ? `${serializeOperand(o[0])} Tw ${serializeOperand(o[1])} Tc T* ` : '';
    splices.push({ start: op.start, end: op.end, text: prefix + shown });
  }
  return splices;
}

