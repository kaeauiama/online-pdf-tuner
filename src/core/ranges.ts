// ページ範囲の文字列(例: "1-3, 5, 8-")の解釈と、分割の計画。
// ページ番号は利用者向けに 1 始まりで受け取り、戻り値は 0 始まりのインデックスで返す。
import { fail, ok, type Result } from './reasons.ts';

/**
 * カンマ区切りの各範囲を 1 グループとして返す。
 * "1-3, 5, 8-" → [[0,1,2], [4], [7..last]]
 * 全角数字・全角記号(「１－３、５」など)も受け付ける。
 */
export function parsePageRanges(input: string, pageCount: number): Result<number[][]> {
  const normalized = input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−ー〜～]/g, '-')
    .replace(/[、，]/g, ',')
    .trim();
  if (normalized === '') return fail('RANGE_EMPTY');

  const groups: number[][] = [];
  for (const raw of normalized.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3]) || (!m[2] && m[3])) return fail('RANGE_SYNTAX', part);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      return fail('RANGE_OUT_OF_BOUNDS', `${part}(全 ${pageCount} ページ)`);
    }
    if (start > end) return fail('RANGE_SYNTAX', `${part}(始まりが終わりより大きい)`);
    groups.push(Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
  }
  if (groups.length === 0) return fail('RANGE_EMPTY');
  return ok(groups);
}

export type SplitPlan =
  | { mode: 'each' }
  | { mode: 'every'; size: number }
  | { mode: 'ranges'; input: string };

/** 分割の計画を、ページインデックス(0 始まり)のグループ列にする */
export function planSplit(plan: SplitPlan, pageCount: number): Result<number[][]> {
  if (pageCount === 0) return fail('NO_PAGES');
  switch (plan.mode) {
    case 'each':
      return ok(Array.from({ length: pageCount }, (_, i) => [i]));
    case 'every': {
      if (!Number.isInteger(plan.size) || plan.size < 1) return fail('RANGE_SYNTAX', String(plan.size));
      const groups: number[][] = [];
      for (let i = 0; i < pageCount; i += plan.size) {
        groups.push(Array.from({ length: Math.min(plan.size, pageCount - i) }, (_, j) => i + j));
      }
      return ok(groups);
    }
    case 'ranges':
      return parsePageRanges(plan.input, pageCount);
  }
}

/** グループのページ番号を、ファイル名用のラベル(例: "p1-3"、"p5")にする */
export function groupLabel(group: readonly number[]): string {
  if (group.length === 0) return 'empty';
  const first = group[0] + 1;
  const last = group[group.length - 1] + 1;
  const contiguous = group.every((v, i) => i === 0 || v === group[i - 1] + 1);
  if (group.length === 1) return `p${first}`;
  return contiguous ? `p${first}-${last}` : `p${first}_etc`;
}
