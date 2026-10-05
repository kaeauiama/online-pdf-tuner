// 画面の状態。ページの並びは不変の配列として持ち、変更のたびに履歴へ積む(元に戻す/やり直す)。
import { createPageRefs, type PageRef, type SourceId } from '../core/pageList.ts';

export const SOURCE_COLOR_COUNT = 8;
const HISTORY_LIMIT = 100;

export interface Source {
  readonly id: SourceId;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** ファイルを見分ける色の番号(0 〜 SOURCE_COLOR_COUNT-1) */
  readonly colorIndex: number;
}

export class Store {
  /** 読み込んだファイル。元に戻す操作でページが復活しうるため、ファイル自体は削除しない */
  readonly sources = new Map<SourceId, Source>();
  pages: readonly PageRef[] = [];
  selection: ReadonlySet<string> = new Set();
  /** Shift+クリックの起点 */
  anchor: string | null = null;

  private past: (readonly PageRef[])[] = [];
  private future: (readonly PageRef[])[] = [];
  private readonly listeners = new Set<() => void>();
  private sourceCount = 0;

  subscribe(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  addSource(name: string, bytes: Uint8Array, pageCount: number): Source {
    const n = this.sourceCount++;
    const source: Source = { id: `s${n + 1}`, name, bytes, pageCount, colorIndex: n % SOURCE_COLOR_COUNT };
    this.sources.set(source.id, source);
    this.commit([...this.pages, ...createPageRefs(source.id, pageCount)]);
    return source;
  }

  /** ページの並びを変更する(履歴に積む) */
  commit(next: readonly PageRef[]): void {
    this.past.push(this.pages);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.pages = next;
    this.pruneSelection();
    this.emit();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.pages);
    this.pages = prev;
    this.pruneSelection();
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.pages);
    this.pages = next;
    this.pruneSelection();
    this.emit();
  }

  select(keys: Iterable<string>, anchor: string | null = this.anchor): void {
    this.selection = new Set(keys);
    this.anchor = anchor;
    this.emit();
  }

  /** 並びに存在するファイル(ページが 1 枚以上残っているもの)を、最初に現れる順で返す */
  activeSources(): Source[] {
    const seen = new Set<SourceId>();
    const out: Source[] = [];
    for (const p of this.pages) {
      if (seen.has(p.sourceId)) continue;
      seen.add(p.sourceId);
      const s = this.sources.get(p.sourceId);
      if (s) out.push(s);
    }
    return out;
  }

  sourceBytes(): ReadonlyMap<SourceId, Uint8Array> {
    return new Map([...this.sources].map(([id, s]) => [id, s.bytes]));
  }

  private pruneSelection(): void {
    const present = new Set(this.pages.map((p) => p.key));
    const kept = [...this.selection].filter((k) => present.has(k));
    if (kept.length !== this.selection.size) this.selection = new Set(kept);
    if (this.anchor && !present.has(this.anchor)) this.anchor = null;
  }
}
