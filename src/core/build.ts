// ページ参照の並びから、新しい PDF を書き出す。
import { degrees, PDFDocument } from '@cantoo/pdf-lib';
import { zipSync } from 'fflate';
import { normalizeRotation, type PageRef, type SourceId } from './pageList.ts';
import { loadPdfForEditOrThrow } from './pdfLoad.ts';
import { ReasonError } from './reasons.ts';

export type SourceBytes = ReadonlyMap<SourceId, Uint8Array>;

/** 読み込み済みの元文書をキャッシュする(分割で同じ元文書を何度も使うため) */
export class SourceCache {
  private readonly docs = new Map<SourceId, Promise<PDFDocument>>();

  constructor(private readonly sources: SourceBytes) {}

  get(sourceId: SourceId): Promise<PDFDocument> {
    let doc = this.docs.get(sourceId);
    if (!doc) {
      const bytes = this.sources.get(sourceId);
      if (!bytes) throw new Error(`unknown source: ${sourceId}`);
      doc = loadPdfForEditOrThrow(bytes);
      this.docs.set(sourceId, doc);
    }
    return doc;
  }
}

export async function buildPdf(cache: SourceCache, pages: readonly PageRef[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new ReasonError('NO_PAGES');
  const out = await PDFDocument.create({ updateMetadata: false });

  // 同じ元文書から連続するページをまとめて copyPages する(呼び出し回数を減らす)
  let i = 0;
  while (i < pages.length) {
    const sourceId = pages[i].sourceId;
    let j = i;
    while (j < pages.length && pages[j].sourceId === sourceId) j++;
    const run = pages.slice(i, j);
    const src = await cache.get(sourceId);
    const copied = await out.copyPages(src, run.map((p) => p.pageIndex));
    copied.forEach((page, k) => {
      const extra = run[k].rotation;
      if (extra !== 0) {
        page.setRotation(degrees(normalizeRotation(page.getRotation().angle + extra)));
      }
      out.addPage(page);
    });
    i = j;
  }
  return out.save({ useObjectStreams: true });
}

export interface NamedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 複数ファイルを 1 つの ZIP にまとめる。PDF は圧縮済みなので無圧縮で格納する */
export function zipFiles(files: readonly NamedFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const f of files) entries[uniqueName(entries, f.name)] = [f.bytes, { level: 0 }];
  return zipSync(entries);
}

function uniqueName(existing: Record<string, unknown>, name: string): string {
  if (!(name in existing)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const candidate = `${base}(${n})${ext}`;
    if (!(candidate in existing)) return candidate;
  }
}

/** 拡張子を除いたファイル名。出力ファイル名の元にする */
export function baseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || 'document';
}
