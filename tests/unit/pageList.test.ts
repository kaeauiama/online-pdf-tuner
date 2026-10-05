import { describe, expect, it } from 'vitest';
import {
  createPageRefs,
  keysBetween,
  movePages,
  normalizeRotation,
  nudgePages,
  pickPages,
  removePages,
  removeSource,
  rotatePages,
  type PageRef,
} from '../../src/core/pageList.ts';

const keysOf = (pages: readonly PageRef[]) => pages.map((p) => p.key);
const pages = () => [...createPageRefs('a', 3), ...createPageRefs('b', 2)];
// a:0 a:1 a:2 b:0 b:1

describe('createPageRefs', () => {
  it('元ファイルのページ順に参照を作る', () => {
    expect(keysOf(createPageRefs('x', 3))).toEqual(['x:0', 'x:1', 'x:2']);
    expect(createPageRefs('x', 2).every((p) => p.rotation === 0)).toBe(true);
  });
});

describe('normalizeRotation', () => {
  it.each([
    [0, 0],
    [90, 90],
    [360, 0],
    [450, 90],
    [-90, 270],
    [-270, 90],
  ])('%i → %i', (input, expected) => {
    expect(normalizeRotation(input)).toBe(expected);
  });
});

describe('rotatePages', () => {
  it('選択したページだけ回転する', () => {
    const r = rotatePages(pages(), new Set(['a:1']), 90);
    expect(r.map((p) => p.rotation)).toEqual([0, 90, 0, 0, 0]);
    const back = rotatePages(r, new Set(['a:1']), -90);
    expect(back[1].rotation).toBe(0);
  });
});

describe('removePages / removeSource / pickPages', () => {
  it('選択したページを削除する', () => {
    expect(keysOf(removePages(pages(), new Set(['a:0', 'b:1'])))).toEqual(['a:1', 'a:2', 'b:0']);
  });
  it('ファイル単位で削除する', () => {
    expect(keysOf(removeSource(pages(), 'a'))).toEqual(['b:0', 'b:1']);
  });
  it('選択したページを並び順のまま取り出す', () => {
    expect(keysOf(pickPages(pages(), new Set(['b:0', 'a:1'])))).toEqual(['a:1', 'b:0']);
  });
});

describe('movePages', () => {
  it('1 ページを先頭へ移動する', () => {
    expect(keysOf(movePages(pages(), new Set(['b:0']), 0))).toEqual(['b:0', 'a:0', 'a:1', 'a:2', 'b:1']);
  });
  it('1 ページを末尾へ移動する', () => {
    expect(keysOf(movePages(pages(), new Set(['a:0']), 5))).toEqual(['a:1', 'a:2', 'b:0', 'b:1', 'a:0']);
  });
  it('離れた複数ページを、相対順を保ってまとめて移動する', () => {
    // a:0 と b:0 を「a:2 の前」(インデックス 2)へ
    expect(keysOf(movePages(pages(), new Set(['a:0', 'b:0']), 2))).toEqual(['a:1', 'a:0', 'b:0', 'a:2', 'b:1']);
  });
  it('範囲外の挿入位置は端に丸める', () => {
    expect(keysOf(movePages(pages(), new Set(['a:1']), 99))).toEqual(['a:0', 'a:2', 'b:0', 'b:1', 'a:1']);
    expect(keysOf(movePages(pages(), new Set(['a:1']), -5))).toEqual(['a:1', 'a:0', 'a:2', 'b:0', 'b:1']);
  });
  it('対象がなければ並びを変えない', () => {
    expect(keysOf(movePages(pages(), new Set(), 0))).toEqual(keysOf(pages()));
  });
});

describe('nudgePages', () => {
  it('選択を 1 つ前・後ろへずらす', () => {
    expect(keysOf(nudgePages(pages(), new Set(['a:2']), -1))).toEqual(['a:0', 'a:2', 'a:1', 'b:0', 'b:1']);
    expect(keysOf(nudgePages(pages(), new Set(['a:2']), 1))).toEqual(['a:0', 'a:1', 'b:0', 'a:2', 'b:1']);
  });
  it('端ではそれ以上動かない', () => {
    expect(keysOf(nudgePages(pages(), new Set(['a:0']), -1))).toEqual(keysOf(pages()));
    expect(keysOf(nudgePages(pages(), new Set(['b:1']), 1))).toEqual(keysOf(pages()));
  });
});

describe('keysBetween', () => {
  it('アンカーからクリック位置までの範囲を返す(逆方向も)', () => {
    expect(keysBetween(pages(), 'a:1', 'b:0')).toEqual(['a:1', 'a:2', 'b:0']);
    expect(keysBetween(pages(), 'b:0', 'a:1')).toEqual(['a:1', 'a:2', 'b:0']);
  });
});
