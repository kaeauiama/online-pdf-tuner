import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { baseName, buildPdf, SourceCache, zipFiles } from '../../src/core/build.ts';
import { createPageRefs, movePages, removePages, rotatePages } from '../../src/core/pageList.ts';
import { describePdf, makePdf } from './helpers.ts';

async function setup() {
  const a = await makePdf([101, 102, 103]);
  const b = await makePdf([201, 202]);
  const cache = new SourceCache(
    new Map([
      ['a', a],
      ['b', b],
    ]),
  );
  const pages = [...createPageRefs('a', 3), ...createPageRefs('b', 2)];
  return { cache, pages };
}

describe('buildPdf', () => {
  it('2 つの PDF を結合する', async () => {
    const { cache, pages } = await setup();
    const out = await describePdf(await buildPdf(cache, pages));
    expect(out.map((p) => p.width)).toEqual([101, 102, 103, 201, 202]);
  });

  it('並べ替え・削除・回転を反映する', async () => {
    const { cache, pages } = await setup();
    let edited = movePages(pages, new Set(['b:1']), 0); // b:1 a:0 a:1 a:2 b:0
    edited = removePages(edited, new Set(['a:1'])); // b:1 a:0 a:2 b:0
    edited = rotatePages(edited, new Set(['a:2']), 90);
    edited = rotatePages(edited, new Set(['b:0']), -90);
    const out = await describePdf(await buildPdf(cache, edited));
    expect(out).toEqual([
      { width: 202, rotation: 0 },
      { width: 101, rotation: 0 },
      { width: 103, rotation: 90 },
      { width: 201, rotation: 270 },
    ]);
  });

  it('元ページの回転に追加の回転を足す', async () => {
    const { PDFDocument, degrees } = await import('@cantoo/pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).setRotation(degrees(90));
    const cache = new SourceCache(new Map([['r', await doc.save()]]));
    const pages = rotatePages(createPageRefs('r', 1), new Set(['r:0']), 90);
    const out = await describePdf(await buildPdf(cache, pages));
    expect(out[0].rotation).toBe(180);
  });

  it('同じ元ページを複数回使える(分割で同じキャッシュを再利用する)', async () => {
    const { cache, pages } = await setup();
    const first = await describePdf(await buildPdf(cache, pages.slice(0, 2)));
    const second = await describePdf(await buildPdf(cache, pages.slice(1, 4)));
    expect(first.map((p) => p.width)).toEqual([101, 102]);
    expect(second.map((p) => p.width)).toEqual([102, 103, 201]);
  });

  it('ページが空なら NO_PAGES', async () => {
    const { cache } = await setup();
    await expect(buildPdf(cache, [])).rejects.toMatchObject({ code: 'NO_PAGES' });
  });

  it('壊れた元ファイルは INVALID_PDF', async () => {
    const cache = new SourceCache(new Map([['x', new TextEncoder().encode('not a pdf')]]));
    await expect(buildPdf(cache, createPageRefs('x', 1))).rejects.toMatchObject({ code: 'INVALID_PDF' });
  });
});

describe('zipFiles', () => {
  it('複数ファイルを ZIP にまとめ、同名は番号を付けて区別する', () => {
    const zip = zipFiles([
      { name: 'a.pdf', bytes: new Uint8Array([1]) },
      { name: 'a.pdf', bytes: new Uint8Array([2]) },
      { name: 'b.pdf', bytes: new Uint8Array([3]) },
    ]);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['a(2).pdf', 'a.pdf', 'b.pdf']);
    expect([...files['a(2).pdf']]).toEqual([2]);
  });
});

describe('baseName', () => {
  it('拡張子 .pdf を除く', () => {
    expect(baseName('会報 2026.PDF')).toBe('会報 2026');
    expect(baseName('.pdf')).toBe('document');
  });
});
