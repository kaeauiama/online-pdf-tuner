// ページ内の編集(M6): 要素の移動・拡大縮小・削除を、コンテンツストリームに書き込む(純粋関数)。
//
// 移動・拡大縮小は、要素の q の直後に cm を 1 つ差し込む。ページ座標での変換 M を、その時点の CTM(C)の座標系に
// 直して書く: C × M × C⁻¹(PDF の cm は「新しい行列 × 現在の CTM」のため)。削除は q 〜 Q を取り除く。
import { lexContent } from '../pdf/lexer.ts';
import { serializeOperand, spliceAll } from '../pdf/serialize.ts';
import { invert, multiply, type Matrix } from '../print/geometry.ts';
import type { PageElement } from './elements.ts';

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

export function applyElementEdits(content: Uint8Array, elements: readonly PageElement[], edits: ReadonlyMap<number, ElementEdit>): Uint8Array {
  const ops = lexContent(content);
  const splices: { start: number; end: number; text: string }[] = [];
  for (const [id, edit] of edits) {
    const e = elements[id];
    if (!e) continue;
    if (edit.kind === 'transform') {
      if (!e.movable || !e.block) continue;
      const q = ops[e.block.q];
      splices.push({ start: q.end, end: q.end, text: ` ${formatMatrix(localTransform(e.ctm, pageTransform(edit)))} cm` });
    } else if (e.movable && e.block) {
      splices.push({ start: ops[e.block.q].start, end: ops[e.block.Q].end, text: '' });
    } else {
      // q 〜 Q ごとに消せない要素は、描画の命令だけを消す(パスは「塗らずに終える」に変える)
      for (const ev of e.events) {
        const op = ops[ev.opIndex];
        splices.push({ start: op.start, end: op.end, text: PATH_PAINT.has(op.op) ? 'n' : '' });
      }
    }
  }
  return spliceAll(content, splices);
}
