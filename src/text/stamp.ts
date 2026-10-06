// 文字入れ・ページ番号(M5)。日本語フォント(BIZ UDPゴシック)を埋め込んで、ページに文字を描く。
// 色は印刷向けに CMYK で指定する(RGB の黒は印刷時に 4 色の黒になり、小さな文字がにじむため)。
// 位置は「画面上の向き」で指定し、ページの回転(/Rotate)に合わせてページ座標に変換する。
import { cmyk, degrees, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import { mmToPt } from '../print/geometry.ts';

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type InkColor = 'black' | 'gray' | 'white' | 'red' | 'blue';

export const INK_COLORS: Record<InkColor, { readonly label: string; readonly cmyk: readonly [number, number, number, number]; readonly css: string }> = {
  black: { label: '黒(K100)', cmyk: [0, 0, 0, 1], css: '#231f20' },
  gray: { label: 'グレー(K60)', cmyk: [0, 0, 0, 0.6], css: '#808285' },
  white: { label: '白', cmyk: [0, 0, 0, 0], css: '#ffffff' },
  red: { label: '赤(M100 Y100)', cmyk: [0, 1, 1, 0], css: '#ed1c24' },
  blue: { label: '青(C100 M60)', cmyk: [1, 0.6, 0, 0], css: '#0062ac' },
};

export interface StampSpec {
  readonly sizePt: number;
  readonly color: InkColor;
  readonly anchor: Anchor;
  /** 端からの距離(mm)。x は左右の端から、y は上下の端から。中央寄せの向きでは、中央からのずれ */
  readonly marginMm: { readonly x: number; readonly y: number };
}

/** 行の間隔(文字の大きさに対する倍率) */
const LINE_HEIGHT = 1.4;

/** 画面上の座標(左下原点、回転後)を、ページ座標に変換する */
export function displayToUser(
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
  dx: number,
  dy: number,
): [number, number] {
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [x1 - dy, y0 + dx];
    case 180:
      return [x1 - dx, y1 - dy];
    case 270:
      return [x0 + dy, y1 - dx];
    default:
      return [x0 + dx, y0 + dy];
  }
}

/** フォントにない字(描くと「□」になる字)を返す */
export function missingChars(font: PDFFont, text: string): string[] {
  const supported = new Set(font.getCharacterSet());
  return [...new Set(Array.from(text.replace(/\n/g, '')).filter((c) => !supported.has(c.codePointAt(0)!)))];
}

/**
 * ページに文字を描く。text は改行(\n)で複数行にできる。
 * 位置の基準は仕上がり位置(TrimBox。なければ表示範囲)。rotation は画面上の向き(ページの /Rotate + 編集での回転)
 */
export function stampText(page: PDFPage, font: PDFFont, spec: StampSpec, text: string, rotation: number): void {
  const box = page.getTrimBox();
  const r = ((rotation % 360) + 360) % 360;
  const width = r === 90 || r === 270 ? box.height : box.width;
  const height = r === 90 || r === 270 ? box.width : box.height;
  const size = spec.sizePt;
  const lines = text.split('\n');
  const lineWidths = lines.map((l) => font.widthOfTextAtSize(l, size));
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = font.heightAtSize(size) - ascent;
  const blockHeight = ascent + descent + (lines.length - 1) * size * LINE_HEIGHT;
  const mx = mmToPt(spec.marginMm.x);
  const my = mmToPt(spec.marginMm.y);
  const [vertical, horizontal] = spec.anchor === 'center' ? ['middle', 'center'] : spec.anchor.split('-');

  const top = vertical === 'top' ? height - my : vertical === 'bottom' ? my + blockHeight : (height + blockHeight) / 2 - my;
  const [c, m, y, k] = INK_COLORS[spec.color].cmyk;
  lines.forEach((line, i) => {
    const w = lineWidths[i];
    const left =
      horizontal === 'left' ? mx : horizontal === 'right' ? width - mx - w : (width - w) / 2 + mx;
    const baseline = top - ascent - i * size * LINE_HEIGHT;
    const [ux, uy] = displayToUser(box, r, left, baseline);
    page.drawText(line, { x: ux, y: uy, size, font, color: cmyk(c, m, y, k), rotate: degrees(r) });
  });
}

// ---------- ページ番号 ----------

export type PageNumberFormat = 'plain' | 'dash' | 'slash' | 'p';

export const PAGE_NUMBER_FORMATS: Record<PageNumberFormat, { readonly label: string; readonly format: (n: number, last: number) => string }> = {
  plain: { label: '1', format: (n) => String(n) },
  dash: { label: '- 1 -', format: (n) => `- ${n} -` },
  slash: { label: '1 / 8', format: (n, last) => `${n} / ${last}` },
  p: { label: 'p. 1', format: (n) => `p. ${n}` },
};

/**
 * ページ番号の割り当て。並びの先頭から skipFirst ページは番号を入れず、その次のページを start 番にする。
 * 戻り値: 並びの位置(0 始まり)→ 番号。last は最後の番号
 */
export function planPageNumbers(count: number, start: number, skipFirst: number): { numbers: Map<number, number>; last: number } {
  const numbers = new Map<number, number>();
  for (let i = skipFirst; i < count; i++) numbers.set(i, start + (i - skipFirst));
  return { numbers, last: start + Math.max(0, count - skipFirst - 1) };
}
