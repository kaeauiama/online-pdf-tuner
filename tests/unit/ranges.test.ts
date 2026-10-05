import { describe, expect, it } from 'vitest';
import { groupLabel, parsePageRanges, planSplit } from '../../src/core/ranges.ts';

describe('parsePageRanges', () => {
  it('範囲・単独・末尾までを解釈する', () => {
    expect(parsePageRanges('1-3, 5, 8-', 9)).toEqual({ ok: true, value: [[0, 1, 2], [4], [7, 8]] });
  });
  it('「-3」は先頭から 3 ページ目まで', () => {
    expect(parsePageRanges('-3', 5)).toEqual({ ok: true, value: [[0, 1, 2]] });
  });
  it('全角数字・全角記号・読点を受け付ける', () => {
    expect(parsePageRanges('１－２、４', 5)).toEqual({ ok: true, value: [[0, 1], [3]] });
    expect(parsePageRanges('2〜3', 5)).toEqual({ ok: true, value: [[1, 2]] });
  });
  it('空欄は RANGE_EMPTY', () => {
    expect(parsePageRanges('  ', 5)).toMatchObject({ ok: false, code: 'RANGE_EMPTY' });
    expect(parsePageRanges(',,', 5)).toMatchObject({ ok: false, code: 'RANGE_EMPTY' });
  });
  it('不正な書式は RANGE_SYNTAX', () => {
    expect(parsePageRanges('a', 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
    expect(parsePageRanges('1-2-3', 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
    expect(parsePageRanges('-', 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
    expect(parsePageRanges('4-2', 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
  });
  it('存在しないページは RANGE_OUT_OF_BOUNDS', () => {
    expect(parsePageRanges('0', 5)).toMatchObject({ ok: false, code: 'RANGE_OUT_OF_BOUNDS' });
    expect(parsePageRanges('3-6', 5)).toMatchObject({ ok: false, code: 'RANGE_OUT_OF_BOUNDS' });
  });
});

describe('planSplit', () => {
  it('1 ページずつ', () => {
    expect(planSplit({ mode: 'each' }, 3)).toEqual({ ok: true, value: [[0], [1], [2]] });
  });
  it('N ページごと(端数は最後のグループ)', () => {
    expect(planSplit({ mode: 'every', size: 2 }, 5)).toEqual({ ok: true, value: [[0, 1], [2, 3], [4]] });
  });
  it('N が不正なら RANGE_SYNTAX', () => {
    expect(planSplit({ mode: 'every', size: 0 }, 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
    expect(planSplit({ mode: 'every', size: 1.5 }, 5)).toMatchObject({ ok: false, code: 'RANGE_SYNTAX' });
  });
  it('ページがなければ NO_PAGES', () => {
    expect(planSplit({ mode: 'each' }, 0)).toMatchObject({ ok: false, code: 'NO_PAGES' });
  });
});

describe('groupLabel', () => {
  it('ファイル名用のラベルを作る', () => {
    expect(groupLabel([0])).toBe('p1');
    expect(groupLabel([0, 1, 2])).toBe('p1-3');
    expect(groupLabel([0, 2])).toBe('p1_etc');
  });
});
