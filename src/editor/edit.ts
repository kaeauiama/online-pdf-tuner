// ページ内の編集(M6): 要素の移動・拡大縮小・削除を、コンテンツストリームに書き込む(純粋関数)。
//
// 移動・拡大縮小は、要素の q の直後に cm を 1 つ差し込む。ページ座標での変換 M を、その時点の CTM(C)の座標系に
// 直して書く: C × M × C⁻¹(PDF の cm は「新しい行列 × 現在の CTM」のため)。削除は q 〜 Q を取り除く。
// 重なり順の変更は、一続きの中の各単位の場所に、新しい順番の要素の単位(それ自体の変更を反映したもの)を入れ直す(order.ts)。
// 文字の書き換え(textEdit.ts)は、文字表示の命令の置き換えとして受け取り、同じ位置基準でまとめて書き込む。
import { lexContent } from '../pdf/lexer.ts';
import { serializeOperand, spliceAll, type Splice } from '../pdf/serialize.ts';
import { invert, multiply, type Matrix } from '../print/geometry.ts';
import type { PageElement } from './elements.ts';
import { analyzeLayering, slotAssignments } from './order.ts';

export type ElementEdit =
  | {
      readonly kind: 'transform';
      /** 移動量(pt、ページ座標) */
      readonly dx: number;
      readonly dy: number;
      /** 拡大率(1 = そのまま)。anchor を中心に縦横同じ率で拡大縮小する */
      readonly scale: number;
      readonly anchor: readonly [number, number];
    }
  | { readonly kind: 'delete' };

const PATH_PAINT = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*']);

/** ページ座標での変換(anchor を中心に拡大縮小してから移動) */
export function pageTransform(edit: Extract<ElementEdit, { kind: 'transform' }>): Matrix {
  const [ax, ay] = edit.anchor;
  const s = edit.scale;
  return [s, 0, 0, s, ax - s * ax + edit.dx, ay - s * ay + edit.dy];
}

/** ページ座標での変換 M を、CTM が C の座標系での cm に直す */
export function localTransform(ctm: Matrix, m: Matrix): Matrix {
  const inverse = invert(ctm);
  if (!inverse) return m;
  return multiply(multiply(ctm, m), inverse);
}

function formatMatrix(m: Matrix): string {
  return m.map((v) => serializeOperand({ type: 'number', value: Math.abs(v) < 1e-9 ? 0 : v })).join(' ');
}

/**
 * 要素の変更をコンテンツに書き込む。
 * order: 要素の描画の順番(奥から手前。省略時は元のまま)。textSplices: 文字表示の命令の置き換え(元のコンテンツの位置)
 */
export function applyElementEdits(
  content: Uint8Array,
  elements: readonly PageElement[],
  edits: ReadonlyMap<number, ElementEdit>,
  order?: readonly number[],
  textSplices: readonly Splice[] = [],
): Uint8Array {
  const ops = lexContent(content);
  const deleted = (start: number, end: number) =>
    [...edits].some(([id, edit]) => {
      const e = elements[id];
      if (edit.kind !== 'delete' || !e) return false;
      if (e.movable && e.block) return start >= ops[e.block.q].start && end <= ops[e.block.Q].end;
      return e.events.some((ev) => start >= ops[ev.opIndex].start && end <= ops[ev.opIndex].end);
    });
  // 消す要素の中の文字の書き換えは捨てる
  const texts = textSplices.filter((t) => !deleted(t.start, t.end));

  /** 要素それ自体の変更(移動の cm・削除) */
  const ownSplices = (e: PageElement): Splice[] => {
    const edit = edits.get(e.id);
    if (!edit) return [];
    if (edit.kind === 'transform') {
      if (!e.movable || !e.block) return [];
      const q = ops[e.block.q];
      return [{ start: q.end, end: q.end, text: ` ${formatMatrix(localTransform(e.ctm, pageTransform(edit)))} cm` }];
    }
    if (e.movable && e.block) return [{ start: ops[e.block.q].start, end: ops[e.block.Q].end, text: '' }];
    // q 〜 Q ごとに消せない要素は、描画の命令だけを消す(パスは「塗らずに終える」に変える)
    return e.events.map((ev) => {
      const op = ops[ev.opIndex];
      return { start: op.start, end: op.end, text: PATH_PAINT.has(op.op) ? 'n' : '' };
    });
  };

  const layering = order ? analyzeLayering(ops, elements) : undefined;
  const slots = order && layering ? slotAssignments(order, layering) : new Map<number, number>();
  const splices: Splice[] = [];
  const inMovedUnit: { start: number; end: number }[] = [];
  if (layering && slots.size > 0) {
    const range = (id: number) => {
      const u = layering.unitOf.get(id)!;
      return { start: ops[u.first].start, end: ops[u.last].end };
    };
    for (const [slot, id] of slots) {
      const from = range(id);
      const to = range(slot);
      const inner = [...ownSplices(elements[id]), ...texts.filter((t) => t.start >= from.start && t.end <= from.end)];
      const bytes = spliceAll(
        content.slice(from.start, from.end),
        inner.map((x) => ({ ...x, start: x.start - from.start, end: x.end - from.start })),
      );
      splices.push({ start: to.start, end: to.end, bytes });
      inMovedUnit.push(from);
    }
  }
  const moved = (x: { start: number; end: number }) => inMovedUnit.some((u) => x.start >= u.start && x.end <= u.end);
  for (const id of edits.keys()) {
    const e = elements[id];
    if (e) splices.push(...ownSplices(e).filter((x) => !moved(x)));
  }
  splices.push(...texts.filter((t) => !moved(t)));
  return spliceAll(content, splices);
}
