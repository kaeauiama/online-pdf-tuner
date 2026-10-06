// 埋め込まれたフォントから、字形の輪郭(パス)を取り出す。文字のアウトライン化(D-034)で使う。
//
// 対応する形式:
//  - Type0(Identity-H / Identity-V)+ CIDFontType2(TrueType。CIDToGIDMap は Identity または対応表)
//  - Type0 + CIDFontType0(CFF。FontFile3 の OpenType または素の CFF。CID の CFF は charset で CID → 字形)
//  - TrueType(単純フォント。文字コード → Unicode → cmap。記号フォントは (3,0) の領域も見る)
//  - Type1 の素の CFF(Type1C。符号化の名前 → 字形の名前。ASCII の範囲と /Differences)
// 対応しない形式(Type1 の PostScript 形式・Type3・埋め込みなし・Identity 以外の CMap)は理由を返す。
// フォントの許諾(fsType)が「埋め込み不可」と明示されたものは使わない(D-034)。
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { streamBytes } from '../print/structure.ts';
import { loadFontForEdit, permissionOf, readFsType } from './fonts.ts';

export type OutlineFontReason = 'not-embedded' | 'restricted' | 'unsupported' | 'type3';

export interface OutlineGlyph {
  /** 輪郭のパスの命令(字形の空間)。空白など輪郭のない字形は '' */
  readonly path: string;
  readonly bbox: readonly [number, number, number, number];
  /** 字形の空間 → 文字の空間(1em = 1)の倍率 */
  readonly scale: number;
  /** フォームとして共有するときの識別子 */
  readonly key: string;
}

export interface OutlineFont {
  readonly name: string;
  readonly codeBytes: 1 | 2;
  readonly vertical: boolean;
  /** 字幅(1000 = 1em、PDF の指定) */
  widthOf(code: number): number;
  /** 縦書き: 字送り w1(1000 単位。下へ進むので負)と、字形の原点の位置(vx, vy) */
  verticalMetrics(code: number): { readonly w1: number; readonly vx: number; readonly vy: number };
  /** 字形。対応する字形が見つからなければ undefined */
  glyph(code: number): OutlineGlyph | undefined;
}

export type OutlineFontResult = { readonly ok: true; readonly font: OutlineFont } | { readonly ok: false; readonly reason: OutlineFontReason; readonly name: string; readonly detail?: string };

// fontkit の必要な部分だけの型(動的に読み込むため)
interface FkPathCommand {
  readonly command: string;
  readonly args: readonly number[];
}
interface FkGlyph {
  readonly id: number;
  readonly path: { readonly commands: readonly FkPathCommand[] };
}
interface FkCff {
  readonly isCIDFont: boolean;
  readonly topDict: {
    readonly FontMatrix?: readonly number[];
    readonly charset?: unknown;
    readonly FDArray?: readonly { readonly FontMatrix?: readonly number[] }[];
    readonly CharStrings?: readonly unknown[];
  };
  getGlyphName(gid: number): string | null;
  fdForGlyph(gid: number): number | null;
}
interface FkFont {
  readonly unitsPerEm: number;
  getGlyph(id: number): FkGlyph | null;
  glyphForCodePoint(cp: number): FkGlyph | null;
  readonly 'CFF '?: FkCff;
}

const N = (s: string) => PDFName.of(s);

function resolve(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}
const numberOf = (doc: PDFDocument, o: PDFObject | undefined) => {
  const v = resolve(doc, o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};
const nameOf = (doc: PDFDocument, o: PDFObject | undefined) => {
  const v = resolve(doc, o);
  return v instanceof PDFName ? v.decodeText() : undefined;
};

// ---------- 素の CFF を OpenType の入れ物に入れる(fontkit で読むため) ----------

function table(size: number, fill: (v: DataView) => void): Uint8Array {
  const b = new Uint8Array(size);
  fill(new DataView(b.buffer));
  return b;
}

/** 素の CFF(FontFile3 の CIDFontType0C / Type1C)を、最小限の表を持つ OpenType にする */
export function wrapBareCff(cff: Uint8Array): Uint8Array {
  const tables: [string, Uint8Array][] = [
    ['CFF ', cff],
    [
      'head',
      table(54, (v) => {
        v.setUint32(0, 0x00010000);
        v.setUint32(4, 0x00010000);
        v.setUint32(12, 0x5f0f3cf5);
        v.setUint16(18, 1000);
        v.setUint16(46, 8);
        v.setInt16(48, 2);
      }),
    ],
    [
      'hhea',
      table(36, (v) => {
        v.setUint32(0, 0x00010000);
        v.setInt16(4, 880);
        v.setInt16(6, -120);
        v.setUint16(10, 1000);
        v.setUint16(34, 1);
      }),
    ],
    ['hmtx', table(4, (v) => v.setUint16(0, 1000))],
    [
      'maxp',
      table(6, (v) => {
        v.setUint32(0, 0x00005000);
        v.setUint16(4, 0xffff);
      }),
    ],
  ];
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = tables.length;
  const headerSize = 12 + 16 * n;
  const total = headerSize + tables.reduce((s, [, d]) => s + ((d.length + 3) & ~3), 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x4f54544f); // 'OTTO'
  v.setUint16(4, n);
  const pow = 2 ** Math.floor(Math.log2(n));
  v.setUint16(6, pow * 16);
  v.setUint16(8, Math.log2(pow));
  v.setUint16(10, n * 16 - pow * 16);
  let offset = headerSize;
  tables.forEach(([tag, data], i) => {
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) v.setUint8(rec + k, tag.charCodeAt(k));
    v.setUint32(rec + 8, offset);
    v.setUint32(rec + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

// ---------- 字形の輪郭 → PDF のパス ----------

const fmt = (x: number) => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function pathToPdf(commands: readonly FkPathCommand[]): { path: string; bbox: [number, number, number, number] } {
  const out: string[] = [];
  let cx = 0;
  let cy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const see = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const { command, args: a } of commands) {
    switch (command) {
      case 'moveTo':
        out.push(`${fmt(a[0])} ${fmt(a[1])} m`);
        [cx, cy] = [a[0], a[1]];
        see(cx, cy);
        break;
      case 'lineTo':
        out.push(`${fmt(a[0])} ${fmt(a[1])} l`);
        [cx, cy] = [a[0], a[1]];
        see(cx, cy);
        break;
      case 'quadraticCurveTo': {
        // 2 次ベジェを 3 次に直す
        const [qx, qy, x, y] = a;
        const c1x = cx + (2 / 3) * (qx - cx);
        const c1y = cy + (2 / 3) * (qy - cy);
        const c2x = x + (2 / 3) * (qx - x);
        const c2y = y + (2 / 3) * (qy - y);
        out.push(`${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x)} ${fmt(y)} c`);
        see(qx, qy);
        [cx, cy] = [x, y];
        see(cx, cy);
        break;
      }
      case 'bezierCurveTo':
        out.push(`${a.map(fmt).join(' ')} c`);
        see(a[0], a[1]);
        see(a[2], a[3]);
        [cx, cy] = [a[4], a[5]];
        see(cx, cy);
        break;
      case 'closePath':
        out.push('h');
        break;
    }
  }
  if (!Number.isFinite(x0)) return { path: '', bbox: [0, 0, 0, 0] };
  return { path: out.join(' '), bbox: [x0, y0, x1, y1] };
}

// ---------- 文字コード → 字形 ----------

/** CID の CFF の charset から、CID → 字形 ID の対応を作る */
function cidToGidFromCharset(cff: FkCff): Map<number, number> | undefined {
  const cs = cff.topDict.charset as { version?: number; glyphs?: number[]; ranges?: { first: number; nLeft: number; offset: number }[] } | undefined;
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) return undefined;
  const map = new Map<number, number>([[0, 0]]);
  if (cs.version === 0 && cs.glyphs) cs.glyphs.forEach((cid, i) => map.set(cid, i + 1));
  else if (cs.ranges) for (const r of cs.ranges) for (let k = 0; k <= r.nLeft; k++) map.set(r.first + k, r.offset + 1 + k);
  return map;
}

/** ASCII の範囲の、標準の字形の名前(Type1C の符号化に使う) */
const ASCII_GLYPH_NAMES = (() => {
  const punct =
    'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash'.split(' ');
  const digits = 'zero one two three four five six seven eight nine'.split(' ');
  const mid = 'colon semicolon less equal greater question at'.split(' ');
  const upper = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const between = 'bracketleft backslash bracketright asciicircum underscore grave'.split(' ');
  const lower = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));
  const end = 'braceleft bar braceright asciitilde'.split(' ');
  const names = [...punct, ...digits, ...mid, ...upper, ...between, ...lower, ...end];
  return new Map(names.map((n, i) => [0x20 + i, n]));
})();

/** /Encoding の /Differences を読む */
function differencesOf(doc: PDFDocument, font: PDFDict): Map<number, string> {
  const map = new Map<number, string>();
  const enc = resolve(doc, font.get(N('Encoding')));
  if (!(enc instanceof PDFDict)) return map;
  const diffs = resolve(doc, enc.get(N('Differences')));
  if (!(diffs instanceof PDFArray)) return map;
  let code = 0;
  for (const item of diffs.asArray()) {
    const v = resolve(doc, item);
    if (v instanceof PDFNumber) code = v.asNumber();
    else if (v instanceof PDFName) map.set(code++, v.decodeText());
  }
  return map;
}

function parseW2(doc: PDFDocument, cid: PDFDict): Map<number, [number, number, number]> {
  const map = new Map<number, [number, number, number]>();
  const w2 = resolve(doc, cid.get(N('W2')));
  if (!(w2 instanceof PDFArray)) return map;
  const items = w2.asArray().map((x) => resolve(doc, x));
  const n = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);
  for (let i = 0; i < items.length; ) {
    const first = n(items[i]);
    if (first === undefined) break;
    const next = items[i + 1];
    if (next instanceof PDFArray) {
      const v = next.asArray().map((x) => n(resolve(doc, x)) ?? 0);
      for (let k = 0; k + 2 < v.length; k += 3) map.set(first + k / 3, [v[k], v[k + 1], v[k + 2]]);
      i += 2;
    } else {
      const last = n(next);
      const [w1, vx, vy] = [n(items[i + 2]), n(items[i + 3]), n(items[i + 4])];
      if (last === undefined || w1 === undefined || vx === undefined || vy === undefined) break;
      for (let c = first; c <= last; c++) map.set(c, [w1, vx, vy]);
      i += 5;
    }
  }
  return map;
}

/** フォントを読み込む。fontkit は呼び出し側で読み込んで渡す(動的読み込みのため) */
export async function loadOutlineFont(doc: PDFDocument, fontObj: PDFObject | undefined): Promise<OutlineFontResult> {
  const font = resolve(doc, fontObj);
  const fail = (reason: OutlineFontReason, name: string, detail?: string): OutlineFontResult => ({ ok: false, reason, name, detail });
  if (!(font instanceof PDFDict)) return fail('unsupported', '(不明)', 'フォントの情報が読めません');
  const subtype = nameOf(doc, font.get(N('Subtype')));
  const name = (nameOf(doc, font.get(N('BaseFont'))) ?? '(名前なし)').replace(/^[A-Z]{6}\+/, '');
  if (subtype === 'Type3') return fail('type3', name);

  let cid: PDFDict | undefined;
  let descriptor: PDFDict | undefined;
  let vertical = false;
  if (subtype === 'Type0') {
    const encoding = nameOf(doc, font.get(N('Encoding')));
    if (encoding !== 'Identity-H' && encoding !== 'Identity-V') return fail('unsupported', name, `文字コードの形式(${encoding ?? '不明'})`);
    vertical = encoding === 'Identity-V';
    const descendants = resolve(doc, font.get(N('DescendantFonts')));
    const d = descendants instanceof PDFArray ? resolve(doc, descendants.get(0)) : undefined;
    if (!(d instanceof PDFDict)) return fail('unsupported', name, 'フォントの情報が読めません');
    cid = d;
    descriptor = resolve(doc, cid.get(N('FontDescriptor'))) as PDFDict | undefined;
  } else if (subtype === 'TrueType' || subtype === 'Type1' || subtype === 'MMType1') {
    descriptor = resolve(doc, font.get(N('FontDescriptor'))) as PDFDict | undefined;
  } else {
    return fail('unsupported', name, `フォントの種類(${subtype ?? '不明'})`);
  }
  if (!(descriptor instanceof PDFDict)) return fail('not-embedded', name);

  // フォントの本体
  const file2 = resolve(doc, descriptor.get(N('FontFile2')));
  const file3 = resolve(doc, descriptor.get(N('FontFile3')));
  const file1 = resolve(doc, descriptor.get(N('FontFile')));
  let bytes: Uint8Array;
  let sfnt: boolean;
  if (file2 instanceof PDFStream) {
    bytes = streamBytes(file2);
    sfnt = true;
  } else if (file3 instanceof PDFStream) {
    bytes = streamBytes(file3);
    sfnt = nameOf(doc, file3.dict.get(N('Subtype'))) === 'OpenType';
  } else if (file1 instanceof PDFStream) {
    return fail('unsupported', name, 'Type 1(PostScript)形式のフォント');
  } else {
    return fail('not-embedded', name);
  }
  // 許諾: 「埋め込み不可」と明示されたものだけ使わない(読めないものは、埋め込まれている以上、作成ソフトが確認済みとみなす)
  if (sfnt && permissionOf(readFsType(bytes)) === 'restricted') return fail('restricted', name);

  let fk: FkFont;
  try {
    const { create } = (await import('@cantoo/fontkit')) as unknown as { create: (b: Uint8Array) => FkFont };
    fk = create(sfnt ? bytes : wrapBareCff(bytes));
  } catch {
    return fail('unsupported', name, 'フォントの本体が読めません');
  }
  const cff = fk['CFF '];

  // 字形の空間 → 1em の倍率
  const scaleOf = (gid: number): number => {
    if (!cff) return 1 / (fk.unitsPerEm || 1000);
    const top = cff.topDict.FontMatrix?.[0] ?? 0.001;
    if (cff.isCIDFont && Math.abs(top - 1) < 1e-9) {
      const fd = cff.fdForGlyph(gid);
      return cff.topDict.FDArray?.[fd ?? 0]?.FontMatrix?.[0] ?? 0.001;
    }
    return top;
  };

  // 文字コード → 字形 ID
  let gidOf: (code: number) => number | undefined;
  const edit = loadFontForEdit(doc, '', fontObj);
  if (cid) {
    const cidToGid = resolve(doc, cid.get(N('CIDToGIDMap')));
    if (cidToGid instanceof PDFStream) {
      const map = streamBytes(cidToGid);
      gidOf = (code) => (code * 2 + 1 < map.length ? (map[code * 2] << 8) | map[code * 2 + 1] : undefined);
    } else if (cff?.isCIDFont) {
      const map = cidToGidFromCharset(cff);
      gidOf = (code) => (map ? map.get(code) : code);
    } else {
      gidOf = (code) => code;
    }
  } else if (cff && !sfnt) {
    // Type1C: 符号化の名前 → 字形の名前 → 字形 ID
    const diffs = differencesOf(doc, font);
    const byName = new Map<string, number>();
    const count = cff.topDict.CharStrings?.length ?? 0;
    for (let g = 0; g < count; g++) {
      const n = cff.getGlyphName(g);
      if (n) byName.set(n, g);
    }
    gidOf = (code) => {
      const glyphName = diffs.get(code) ?? ASCII_GLYPH_NAMES.get(code);
      return glyphName ? byName.get(glyphName) : undefined;
    };
  } else {
    // TrueType の単純フォント: Unicode → cmap。記号フォントは (3,0) の領域(0xF000 + コード)とコードそのものも試す
    const flags = numberOf(doc, descriptor.get(N('Flags'))) ?? 0;
    const symbolic = (flags & 4) !== 0;
    gidOf = (code) => {
      const tries: number[] = [];
      const unicode = edit?.toUnicode.get(code);
      if (unicode && Array.from(unicode).length === 1) tries.push(unicode.codePointAt(0)!);
      if (symbolic) tries.push(0xf000 + code);
      tries.push(code);
      for (const cp of tries) {
        const g = fk.glyphForCodePoint(cp);
        if (g && g.id > 0) return g.id;
      }
      return undefined;
    };
  }

  const cache = new Map<number, OutlineGlyph | null>();
  const fontKey = fontObj instanceof PDFRef ? `${fontObj.objectNumber}_${fontObj.generationNumber}` : name.replace(/[^A-Za-z0-9]/g, '');
  const dw2 = cid ? resolve(doc, cid.get(N('DW2'))) : undefined;
  const [dvy, dw1] = dw2 instanceof PDFArray ? dw2.asArray().map((x) => numberOf(doc, x) ?? 0) : [880, -1000];
  const w2 = cid ? parseW2(doc, cid) : new Map<number, [number, number, number]>();
  const widthOf = (code: number) => edit?.widthOf(code) ?? 1000;

  return {
    ok: true,
    font: {
      name,
      codeBytes: cid ? 2 : 1,
      vertical,
      widthOf,
      verticalMetrics(code) {
        const v = w2.get(code);
        return v ? { w1: v[0], vx: v[1], vy: v[2] } : { w1: dw1, vx: widthOf(code) / 2, vy: dvy };
      },
      glyph(code) {
        const gid = gidOf(code);
        // 単純フォントで字形が見つからない(.notdef になる)ものは、輪郭にしない
        if (gid === undefined || (gid === 0 && !cid)) return undefined;
        if (!cache.has(gid)) {
          try {
            const g = fk.getGlyph(gid);
            const { path, bbox } = g ? pathToPdf(g.path.commands) : { path: '', bbox: [0, 0, 0, 0] as [number, number, number, number] };
            cache.set(gid, { path, bbox, scale: scaleOf(gid), key: `${fontKey}_${gid}` });
          } catch {
            cache.set(gid, null);
          }
        }
        return cache.get(gid) ?? undefined;
      },
    },
  };
}
