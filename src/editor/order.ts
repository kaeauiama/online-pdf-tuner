// ページ内の編集: 要素の重なり順(描画の順番)の入れ替え(純粋関数)。設計: docs/spec/03-page-editor.md
//
// q 〜 Q はグラフィックス状態を保存・復元するので、同じ親(同じ q 〜 Q の中、またはページ直下)に並ぶ q 〜 Q どうしは、
// 間に状態を変える命令がなければ、順番を入れ替えてもそれぞれの見た目は変わらない。間に状態を変える命令(色・CTM・
// q で囲まれていない描画・マークの区切りなど)があると、またいだ要素の見た目や意味が変わりうるため、そこで区切る。
// 区切りの間を「一続き」と呼び、入れ替えはその中でだけ行う。
//
// 要素の範囲(単位)は、要素の q 〜 Q を、外側に向かって次のものまで広げる:
//  - 直前の BDC / BMC と直後の EMC(タグ付き PDF のマーク。中身と一緒に動かす)
//  - ほかの要素を含まない外側の q 〜 Q(透明度などの設定を外側の q 〜 Q で行う書き方があるため)
import type { ContentOp } from '../pdf/lexer.ts';
import type { PageElement } from './elements.ts';

/** 要素の間にあっても、見た目にも意味にも影響しない命令 */
const NEUTRAL = new Set(['MP', 'DP', 'BX', 'EX']);
const MARK_BEGIN = new Set(['BDC', 'BMC']);

/** 命令の位置の範囲(両端を含む) */
export interface OrderUnit {
  readonly first: number;
  readonly last: number;
}

export interface Layering {
  /** 一続きごとの要素(コンテンツの中の順) */
  readonly runs: readonly (readonly number[])[];
  /** 要素 → 一続きの番号(入れ替えられる要素だけ) */
  readonly runOf: ReadonlyMap<number, number>;
  readonly unitOf: ReadonlyMap<number, OrderUnit>;
}

export type OrderMove = 'front' | 'forward' | 'backward' | 'back';

export function analyzeLayering(ops: readonly ContentOp[], elements: readonly PageElement[]): Layering {
  // 命令ごとに、その時点で開いている q(なければ -1)と BT の中か。q ごとの対応する Q
  const enclosing: number[] = [];
  const inText: boolean[] = [];
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  let bt = false;
  ops.forEach((op, i) => {
    enclosing.push(stack.length > 0 ? stack[stack.length - 1] : -1);
    inText.push(bt);
    if (op.op === 'q') stack.push(i);
    else if (op.op === 'Q') {
      const q = stack.pop();
      if (q !== undefined) closeOf.set(q, i);
    } else if (op.op === 'BT') bt = true;
    else if (op.op === 'ET') bt = false;
  });

  // 描画の命令の位置 → 要素
  const ownerAt = new Map<number, number>();
  for (const e of elements) for (const ev of e.events) ownerAt.set(ev.opIndex, e.id);
  const onlyOwn = (id: number, from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      const owner = ownerAt.get(i);
      if (owner !== undefined && owner !== id) return false;
    }
    return true;
  };
  const marksBalanced = (from: number, to: number) => {
    let depth = 0;
    for (let i = from; i <= to; i++) {
      if (MARK_BEGIN.has(ops[i].op)) depth++;
      else if (ops[i].op === 'EMC' && --depth < 0) return false;
    }
    return depth === 0;
  };

  const unitOf = new Map<number, OrderUnit>();
  const byParent = new Map<number, number[]>();
  for (const e of elements) {
    if (!e.movable || !e.block || inText[e.block.q] || !marksBalanced(e.block.q + 1, e.block.Q - 1)) continue;
    let first = e.block.q;
    let last = e.block.Q;
    for (;;) {
      if (first > 0 && last < ops.length - 1 && MARK_BEGIN.has(ops[first - 1].op) && ops[last + 1].op === 'EMC') {
        first--;
        last++;
        continue;
      }
      const p = enclosing[first];
      const pQ = p >= 0 ? closeOf.get(p) : undefined;
      if (pQ !== undefined && !inText[p] && onlyOwn(e.id, p, pQ) && marksBalanced(p + 1, pQ - 1)) {
        first = p;
        last = pQ;
        continue;
      }
      break;
    }
    unitOf.set(e.id, { first, last });
    const parent = enclosing[first];
    byParent.set(parent, [...(byParent.get(parent) ?? []), e.id]);
  }

  // 同じ親の中で、間に中立の命令しかない要素どうしを一続きにする
  const runs: number[][] = [];
  const runOf = new Map<number, number>();
  for (const ids of byParent.values()) {
    ids.sort((a, b) => unitOf.get(a)!.first - unitOf.get(b)!.first);
    let run: number[] = [];
    let prevLast = -1;
    for (const id of ids) {
      const u = unitOf.get(id)!;
      const gapNeutral = run.length > 0 && ops.slice(prevLast + 1, u.first).every((op) => NEUTRAL.has(op.op));
      if (!gapNeutral && run.length > 0) {
        runs.push(run);
        run = [];
      }
      run.push(id);
      prevLast = u.last;
    }
    if (run.length > 0) runs.push(run);
  }
  runs.forEach((run, i) => {
    if (run.length > 1) for (const id of run) runOf.set(id, i);
  });
  return { runs, runOf, unitOf };
}

/**
 * 一続きの中の「まとまり」(本体と、その効果・見えない文字)を、いまの描画の順番で並べる。
 * まとまりの一部が一続きの外にあるものは、要素ごとに別のまとまりとして扱う(それ自体は動かせない)
 */
function itemsInRun(order: readonly number[], layering: Layering, run: number, itemOf: (id: number) => number) {
  const pos = new Map(order.map((id, i) => [id, i]));
  const members = layering.runs[run];
  const complete = (key: number) => order.every((id) => itemOf(id) !== key || layering.runOf.get(id) === run);
  const groups = new Map<number, number[]>();
  for (const id of [...members].sort((a, b) => pos.get(a)! - pos.get(b)!)) {
    const key = complete(itemOf(id)) ? itemOf(id) : -(id + 1);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  // まとまりの位置は、本体(代表)の位置
  const anchor = (key: number) => pos.get(key < 0 ? -key - 1 : key)!;
  return [...groups].sort((a, b) => anchor(a[0]) - anchor(b[0]));
}

/** 重なり順を変えられるか、どちらに動かせるか */
export function orderLimits(
  order: readonly number[],
  layering: Layering,
  itemOf: (id: number) => number,
  target: number,
): { reorderable: boolean; forward: boolean; backward: boolean } {
  const run = layering.runOf.get(target);
  const no = { reorderable: false, forward: false, backward: false };
  if (run === undefined || order.some((id) => itemOf(id) === target && layering.runOf.get(id) !== run)) return no;
  const items = itemsInRun(order, layering, run, itemOf);
  const index = items.findIndex(([key]) => key === target);
  if (index < 0) return no;
  return { reorderable: true, forward: index < items.length - 1, backward: index > 0 };
}

/**
 * target(まとまりの代表)の重なり順を動かした、新しい描画の順番を返す。動かせなければ null。
 * order はページ全体の要素の描画の順番(奥から手前)。動かすのは同じ一続きの中だけ
 */
export function moveInOrder(
  order: readonly number[],
  layering: Layering,
  itemOf: (id: number) => number,
  target: number,
  move: OrderMove,
): number[] | null {
  const limits = orderLimits(order, layering, itemOf, target);
  if (!limits.reorderable) return null;
  if ((move === 'front' || move === 'forward') && !limits.forward) return null;
  if ((move === 'back' || move === 'backward') && !limits.backward) return null;
  const run = layering.runOf.get(target)!;
  const items = itemsInRun(order, layering, run, itemOf);
  const index = items.findIndex(([key]) => key === target);
  const [item] = items.splice(index, 1);
  const to = { front: items.length, forward: index + 1, backward: index - 1, back: 0 }[move];
  items.splice(to, 0, item);
  const arranged = items.flatMap(([, ids]) => ids);
  // 一続きの要素が占めていた位置に、新しい並びで入れ直す
  const inRun = new Set(layering.runs[run]);
  let k = 0;
  return order.map((id) => (inRun.has(id) ? arranged[k++] : id));
}

/**
 * 描画の順番 order に合わせて、一続きの中の各単位の場所に入る要素を返す(変わらない一続きは含めない)。
 * 戻り値: 場所(コンテンツの順の要素の単位)→ そこに入れる要素
 */
export function slotAssignments(order: readonly number[], layering: Layering): Map<number, number> {
  const pos = new Map(order.map((id, i) => [id, i]));
  const result = new Map<number, number>();
  for (const run of layering.runs) {
    if (run.length < 2 || run.some((id) => !pos.has(id))) continue;
    const arranged = [...run].sort((a, b) => pos.get(a)! - pos.get(b)!);
    if (arranged.every((id, k) => id === run[k])) continue;
    run.forEach((slot, k) => result.set(slot, arranged[k]));
  }
  return result;
}
