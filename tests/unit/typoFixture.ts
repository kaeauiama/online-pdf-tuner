// テスト用: 誤植修正の対象になる PDF を作る(実際のフォントファイルを使わない)。
// フォント本体は OS/2 テーブル(fsType)だけを持つ最小の TrueType。表示はできないが、解析と置き換えの検証には足りる。
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';

/** fsType を持つ最小の sfnt。fsType が undefined なら OS/2 テーブルを持たない */
export function fakeTrueType(fsType: number | undefined): Uint8Array {
  if (fsType === undefined) {
    const b = new Uint8Array(12);
    new DataView(b.buffer).setUint32(0, 0x00010000);
    return b;
  }
  const b = new Uint8Array(12 + 16 + 10);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, 1);
  b.set([0x4f, 0x53, 0x2f, 0x32], 12); // 'OS/2'
  v.setUint32(12 + 8, 28);
  v.setUint32(12 + 12, 10);
  v.setUint16(28 + 4, 400);
  v.setUint16(28 + 8, fsType);
  return b;
}

/** コード 1〜5 = 講 習 会 回 案。案だけ字幅が 500(ほかは 1000) */
export const FIXTURE_CHARS = ['講', '習', '会', '回', '案'];

function toUnicodeCMap(): string {
  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
  const entries = FIXTURE_CHARS.map((c, i) => `<${hex4(i + 1)}> <${hex4(c.charCodeAt(0))}>`).join('\n');
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${FIXTURE_CHARS.length} beginbfchar
${entries}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/**
 * 「講習回」と書いた 1 ページの PDF。text は字形のコード列(16 進 4 桁ずつ)で上書きできる。
 */
export async function typoPdf(fsType: number | undefined, content = '<000100020004>'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const fontFile = ctx.register(ctx.flateStream(fakeTrueType(fsType)));
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+TestMincho', Flags: 4, FontFile2: fontFile }));
  const cid = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'ABCDEF+TestMincho',
      CIDSystemInfo: { Registry: ctx.obj('(Adobe)' as never), Ordering: ctx.obj('(Identity)' as never), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
      W: [5, [500]],
    }),
  );
  const toUnicode = ctx.register(ctx.flateStream(new TextEncoder().encode(toUnicodeCMap())));
  const font = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+TestMincho', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUnicode }),
  );
  page.node.setFontDictionary(PDFName.of('F1'), font);
  const stream = ctx.flateStream(new TextEncoder().encode(`BT /F1 24 Tf 20 100 Td [${content}] TJ ET`));
  page.node.set(PDFName.of('Contents'), ctx.register(stream));
  return doc.save();
}
