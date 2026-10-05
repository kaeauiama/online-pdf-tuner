// 日本式トンボ(角トンボ + センタートンボ)を描く。
// 寸法は暫定値(U-6)。一般的な DTP ソフトの日本式トンボの見た目に合わせている。
import {
  lineTo,
  moveTo,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  setLineWidth,
  stroke,
  type PDFDocument,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { mmToPt, type Rect } from './geometry.ts';

/** トンボの線の長さ(mm、暫定) */
export const MARK_LENGTH_MM = 10;
/** 塗り足しの外端からページ端までの余白(mm、暫定)。トンボはこの中に描く */
export const MARK_MARGIN_MM = 13;
/** トンボの線幅(pt、暫定)。東京カラー印刷の最小線幅 0.25pt より太くする */
export const MARK_LINE_WIDTH_PT = 0.3;

const REGISTRATION = 'CSRegistration';

/** レジストレーション色(全版に 100% で出る色。Separation /All)をページの資源に登録する */
function registerRegistrationColor(doc: PDFDocument, page: PDFPage): void {
  const ctx = doc.context;
  const tint = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }));
  const colorSpace = ctx.obj(['Separation', 'All', 'DeviceCMYK', tint]);
  const { Resources } = page.node.normalizedEntries();
  let spaces = Resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  if (!spaces) {
    spaces = ctx.obj({});
    Resources.set(PDFName.of('ColorSpace'), spaces);
  }
  spaces.set(PDFName.of(REGISTRATION), colorSpace);
}

type Segment = [number, number, number, number];

/** トンボの線分(pt)。trim = 仕上がり、bleed = 塗り足しの外端 */
export function trimMarkSegments(trim: Rect, bleed: Rect): Segment[] {
  const L = mmToPt(MARK_LENGTH_MM);
  const segs: Segment[] = [];
  // 角トンボ: 各角に、仕上がり線と塗り足し線の位置を示す二重の線を、塗り足しの外側へ伸ばす
  for (const [bx, tx, dir] of [
    [bleed.x0, trim.x0, -1],
    [bleed.x1, trim.x1, 1],
  ] as const) {
    for (const [by, ty, dirY] of [
      [bleed.y0, trim.y0, -1],
      [bleed.y1, trim.y1, 1],
    ] as const) {
      // 横線(y = 仕上がり / 塗り足し)
      segs.push([bx, ty, bx + dir * L, ty], [bx, by, bx + dir * L, by]);
      // 縦線(x = 仕上がり / 塗り足し)
      segs.push([tx, by, tx, by + dirY * L], [bx, by, bx, by + dirY * L]);
    }
  }
  // センタートンボ: 各辺の中央に十字
  const cx = (trim.x0 + trim.x1) / 2;
  const cy = (trim.y0 + trim.y1) / 2;
  const gap = mmToPt(1);
  for (const [y, dir] of [
    [bleed.y0, -1],
    [bleed.y1, 1],
  ] as const) {
    segs.push([cx, y + dir * gap, cx, y + dir * L]);
    segs.push([cx - L / 2, y + (dir * L) / 2, cx + L / 2, y + (dir * L) / 2]);
  }
  for (const [x, dir] of [
    [bleed.x0, -1],
    [bleed.x1, 1],
  ] as const) {
    segs.push([x + dir * gap, cy, x + dir * L, cy]);
    segs.push([x + (dir * L) / 2, cy - L / 2, x + (dir * L) / 2, cy + L / 2]);
  }
  return segs;
}

export function drawTrimMarks(doc: PDFDocument, page: PDFPage, trim: Rect, bleed: Rect): void {
  registerRegistrationColor(doc, page);
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of(REGISTRATION)]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(MARK_LINE_WIDTH_PT),
  ];
  for (const [x0, y0, x1, y1] of trimMarkSegments(trim, bleed)) {
    ops.push(moveTo(x0, y0), lineTo(x1, y1), stroke());
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
}
