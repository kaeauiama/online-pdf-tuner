// サムネイルの遅延描画。画面に入ったカードだけを、同時実行数を絞って描画する。
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SourceId } from '../core/pageList.ts';
import { openForRender, renderThumbnail } from '../render/pdfjs.ts';
import type { Store } from './store.ts';

const THUMB_SIZE = 150;
const CONCURRENCY = 2;

export class Thumbnails {
  private readonly docs = new Map<SourceId, Promise<PDFDocumentProxy>>();
  private readonly queue: { canvas: HTMLCanvasElement; sourceId: SourceId; pageIndex: number }[] = [];
  private running = 0;
  private readonly observer: IntersectionObserver;
  private readonly targets = new WeakMap<Element, { canvas: HTMLCanvasElement; sourceId: SourceId; pageIndex: number }>();

  constructor(private readonly store: Store) {
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: '300px' });
  }

  /** カードを監視対象にする。描画済みの canvas はそのまま使い回す */
  observe(card: Element, canvas: HTMLCanvasElement, sourceId: SourceId, pageIndex: number): void {
    if (canvas.dataset.state) return;
    canvas.dataset.state = 'waiting';
    this.targets.set(card, { canvas, sourceId, pageIndex });
    this.observer.observe(card);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = this.targets.get(entry.target);
      this.observer.unobserve(entry.target);
      if (target) this.queue.push(target);
    }
    this.pump();
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.render(job.canvas, job.sourceId, job.pageIndex).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async render(canvas: HTMLCanvasElement, sourceId: SourceId, pageIndex: number): Promise<void> {
    try {
      const doc = await this.doc(sourceId);
      await renderThumbnail(doc, pageIndex, canvas, THUMB_SIZE);
      canvas.dataset.state = 'done';
    } catch (e) {
      // サムネイルが描けなくても、PDF の結合・分割自体はできる
      canvas.dataset.state = 'error';
      console.warn('thumbnail render failed', sourceId, pageIndex, e);
    }
  }

  private doc(sourceId: SourceId): Promise<PDFDocumentProxy> {
    let doc = this.docs.get(sourceId);
    if (!doc) {
      const source = this.store.sources.get(sourceId);
      if (!source) return Promise.reject(new Error(`unknown source ${sourceId}`));
      doc = openForRender(source.bytes);
      this.docs.set(sourceId, doc);
    }
    return doc;
  }
}
