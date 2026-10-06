// 文字入れ用の日本語フォントを読み込んで、PDF に埋め込む(ブラウザ)。
// フォントはサイト内に同梱(HC-2)。サービスワーカーが保存しているので、オフラインでも読める。
// fontkit は文字入れを使うときだけ読み込む(本体を軽く保つため)。
import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';

export type FontWeight = 'Regular' | 'Bold';

const cache = new Map<FontWeight, Promise<Uint8Array>>();

function loadFontBytes(weight: FontWeight): Promise<Uint8Array> {
  let p = cache.get(weight);
  if (!p) {
    p = fetch(new URL(`fonts/BIZUDPGothic-${weight}.subset.ttf`, document.baseURI)).then(async (res) => {
      if (!res.ok) throw new Error(`font: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    p.catch(() => cache.delete(weight));
    cache.set(weight, p);
  }
  return p;
}

export async function embedJapaneseFont(doc: PDFDocument, weight: FontWeight): Promise<PDFFont> {
  const { default: fontkit } = await import('@cantoo/fontkit');
  doc.registerFontkit(fontkit);
  return doc.embedFont(await loadFontBytes(weight), { subset: true });
}
