// 誤植修正(S1)のための、フォントの情報(文字との対応・字幅・埋め込みの許諾)。
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import { streamBytes } from '../print/structure.ts';
import { parseToUnicode } from './cmap.ts';

/**
 * 埋め込みの許諾(OpenType の OS/2 fsType)。
 * - editable: 埋め込んだ文書の編集を許可(0x0000 インストール可 / 0x0008 編集可)
 * - preview-print: プレビューと印刷のみ(0x0004)。文書の編集は許諾の範囲外
 * - restricted: 埋め込み不可(0x0002)
 * - unknown: 許諾の情報が読めない(OS/2 テーブルがない形式など)
 */
export type EmbeddingPermission = 'editable' | 'preview-print' | 'restricted' | 'unknown';

export interface FontForEdit {
  readonly resourceName: string;
  /** 表示用の名前(サブセット接頭辞を除く) */
  readonly name: string;
  readonly codeBytes: 1 | 2;
  readonly toUnicode: ReadonlyMap<number, string>;
  /** 文字 → コード(同じ文字に複数のコードがあれば最初のもの) */
  readonly fromUnicode: ReadonlyMap<string, number>;
  readonly permission: EmbeddingPermission;
  /** 対応していない形式なら、その理由 */
  readonly unsupported?: string;
  widthOf(code: number): number;
}

const N = (s: string) => PDFName.of(s);

/** sfnt(TrueType / OpenType)のバイト列から OS/2 の fsType を読む */
export function readFsType(font: Uint8Array): number | undefined {
  if (font.length < 12) return undefined;
  const dv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const version = dv.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565 /* true */ && version !== 0x4f54544f /* OTTO */) return undefined;
  const numTables = dv.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > font.length) return undefined;
    if (dv.getUint32(rec) === 0x4f532f32 /* OS/2 */) {
      const offset = dv.getUint32(rec + 8);
      return offset + 10 <= font.length ? dv.getUint16(offset + 8) : undefined;
    }
  }
  return undefined;
}

export function permissionOf(fsType: number | undefined): EmbeddingPermission {
  if (fsType === undefined) return 'unknown';
  // 複数のビットが立っている場合は、最も制限の緩いものを採る(OpenType の仕様)
  if (fsType & 0x0008) return 'editable';
  if (fsType & 0x0004) return 'preview-print';
  if (fsType & 0x0002) return 'restricted';
  return 'editable';
}

// WinAnsiEncoding のうち、ASCII の印字可能文字(コードと文字が同じ範囲)だけを扱う
function winAnsiAscii(): Map<number, string> {
  const m = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) m.set(c, String.fromCharCode(c));
  return m;
}

export function loadFontForEdit(doc: PDFDocument, resourceName: string, fontObj: PDFObject | undefined): FontForEdit | undefined {
  const lookup = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const font = lookup(fontObj);
  if (!(font instanceof PDFDict)) return undefined;
  const subtype = (lookup(font.get(N('Subtype'))) as PDFName | undefined)?.decodeText();
  const baseName = (lookup(font.get(N('BaseFont'))) as PDFName | undefined)?.decodeText() ?? '(名前なし)';
  const name = baseName.replace(/^[A-Z]{6}\+/, '');
  let unsupported: string | undefined;

  let descriptor: PDFDict | undefined;
  let codeBytes: 1 | 2 = 1;
  let widthOf: (code: number) => number;

  if (subtype === 'Type0') {
    codeBytes = 2;
    const encoding = (lookup(font.get(N('Encoding'))) as PDFName | undefined)?.decodeText();
    if (encoding !== 'Identity-H' && encoding !== 'Identity-V') unsupported = `文字コードの形式(${encoding ?? '不明'})に対応していません`;
    const descendants = lookup(font.get(N('DescendantFonts')));
    const cid = descendants instanceof PDFArray ? lookup(descendants.get(0)) : undefined;
    if (cid instanceof PDFDict) {
      descriptor = lookup(cid.get(N('FontDescriptor'))) as PDFDict | undefined;
      const dw = (lookup(cid.get(N('DW'))) as PDFNumber | undefined)?.asNumber() ?? 1000;
      const widths = new Map<number, number>();
      const w = lookup(cid.get(N('W')));
      if (w instanceof PDFArray) {
        const items = w.asArray().map(lookup);
        const n = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);
        // 形式の崩れた W は、読める所まで読む
        for (let i = 0; i < items.length; ) {
          const first = n(items[i]);
          const next = items[i + 1];
          if (first === undefined) break;
          if (next instanceof PDFArray) {
            next.asArray().forEach((v, k) => {
              const width = n(lookup(v));
              if (width !== undefined) widths.set(first + k, width);
            });
            i += 2;
          } else {
            const last = n(next);
            const width = n(items[i + 2]);
            if (last === undefined || width === undefined) break;
            for (let c = first; c <= last; c++) widths.set(c, width);
            i += 3;
          }
        }
      }
      widthOf = (code) => widths.get(code) ?? dw;
    } else {
      widthOf = () => 1000;
      unsupported = 'フォントの情報が読めません';
    }
  } else if (subtype === 'TrueType' || subtype === 'Type1') {
    descriptor = lookup(font.get(N('FontDescriptor'))) as PDFDict | undefined;
    const firstChar = (lookup(font.get(N('FirstChar'))) as PDFNumber | undefined)?.asNumber() ?? 0;
    const widthsArr = lookup(font.get(N('Widths')));
    const widths = widthsArr instanceof PDFArray ? widthsArr.asArray().map((v) => (lookup(v) as PDFNumber).asNumber()) : [];
    widthOf = (code) => widths[code - firstChar] ?? 0;
  } else {
    widthOf = () => 0;
    unsupported = `フォントの種類(${subtype ?? '不明'})に対応していません`;
  }

  // 文字との対応: ToUnicode があればそれを、なければ ASCII の範囲だけ
  let toUnicode: ReadonlyMap<number, string> = new Map();
  const tu = lookup(font.get(N('ToUnicode')));
  if (tu instanceof PDFStream) {
    try {
      toUnicode = parseToUnicode(streamBytes(tu)).toUnicode;
    } catch {
      unsupported ??= '文字の対応表が読めません';
    }
  } else if (codeBytes === 1) {
    toUnicode = winAnsiAscii();
  } else {
    unsupported ??= '文字の対応表(ToUnicode)がありません';
  }
  const fromUnicode = new Map<string, number>();
  for (const [code, ch] of toUnicode) if (!fromUnicode.has(ch)) fromUnicode.set(ch, code);

  // 埋め込みの許諾
  let permission: EmbeddingPermission = 'unknown';
  if (descriptor instanceof PDFDict) {
    for (const key of ['FontFile2', 'FontFile3']) {
      const file = lookup(descriptor.get(N(key)));
      if (file instanceof PDFStream) {
        try {
          permission = permissionOf(readFsType(streamBytes(file)));
        } catch {
          permission = 'unknown';
        }
        break;
      }
    }
    if (!['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor!.has(N(k)))) unsupported ??= 'フォントが埋め込まれていません';
  } else {
    unsupported ??= 'フォントが埋め込まれていません';
  }

  return { resourceName, name, codeBytes, toUnicode, fromUnicode, permission, unsupported, widthOf };
}
