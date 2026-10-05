// 編集中の文書を「ページ参照の並び」として表す。結合・並べ替え・削除・回転・抜き出しは、
// すべてこの並びに対する純粋な操作で、PDF の書き出し(build.ts)とは切り離してある。

export type SourceId = string;
export type Rotation = 0 | 90 | 180 | 270;

export interface PageRef {
  /** 並びの中で一意なキー(UI の選択やドラッグに使う) */
  readonly key: string;
  readonly sourceId: SourceId;
  /** 元ファイル内のページ番号(0 始まり) */
  readonly pageIndex: number;
  /** 元ページの回転に追加する回転量 */
  readonly rotation: Rotation;
}

export function createPageRefs(sourceId: SourceId, pageCount: number): PageRef[] {
  return Array.from({ length: pageCount }, (_, pageIndex) => ({
    key: `${sourceId}:${pageIndex}`,
    sourceId,
    pageIndex,
    rotation: 0,
  }));
}

export function normalizeRotation(degrees: number): Rotation {
  return ((((degrees % 360) + 360) % 360) as Rotation);
}

export function rotatePages(pages: readonly PageRef[], keys: ReadonlySet<string>, delta: 90 | -90 | 180): PageRef[] {
  return pages.map((p) => (keys.has(p.key) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p));
}

export function removePages(pages: readonly PageRef[], keys: ReadonlySet<string>): PageRef[] {
  return pages.filter((p) => !keys.has(p.key));
}

export function removeSource(pages: readonly PageRef[], sourceId: SourceId): PageRef[] {
  return pages.filter((p) => p.sourceId !== sourceId);
}

/**
 * keys のページを、元の相対順を保ったまま targetIndex の位置へ移動する。
 * targetIndex は「移動前の並び」での挿入位置(0 〜 pages.length)。
 */
export function movePages(pages: readonly PageRef[], keys: ReadonlySet<string>, targetIndex: number): PageRef[] {
  const target = Math.max(0, Math.min(targetIndex, pages.length));
  const moving = pages.filter((p) => keys.has(p.key));
  if (moving.length === 0) return [...pages];
  // 挿入位置より前にある移動対象の数だけ、挿入位置が前にずれる
  const shift = pages.slice(0, target).filter((p) => keys.has(p.key)).length;
  const rest = pages.filter((p) => !keys.has(p.key));
  const at = target - shift;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** 選択中のページを 1 つ前(-1)または後ろ(+1)へずらす。キーボード操作用。 */
export function nudgePages(pages: readonly PageRef[], keys: ReadonlySet<string>, direction: -1 | 1): PageRef[] {
  const indices = pages.flatMap((p, i) => (keys.has(p.key) ? [i] : []));
  if (indices.length === 0) return [...pages];
  if (direction === -1) {
    const first = indices[0];
    return first === 0 ? [...pages] : movePages(pages, keys, first - 1);
  }
  const last = indices[indices.length - 1];
  return last === pages.length - 1 ? [...pages] : movePages(pages, keys, last + 2);
}

/** 並び順を保ったまま、keys に含まれるページだけを取り出す */
export function pickPages(pages: readonly PageRef[], keys: ReadonlySet<string>): PageRef[] {
  return pages.filter((p) => keys.has(p.key));
}

/** Shift+クリック用: anchorKey から key までの範囲のキーを返す */
export function keysBetween(pages: readonly PageRef[], anchorKey: string, key: string): string[] {
  const a = pages.findIndex((p) => p.key === anchorKey);
  const b = pages.findIndex((p) => p.key === key);
  if (a < 0 || b < 0) return b < 0 ? [] : [key];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return pages.slice(from, to + 1).map((p) => p.key);
}
