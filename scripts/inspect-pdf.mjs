// PDF の構造を調べる開発用ツール(入稿チェックの下調べ・不具合調査用)。
// 使い方: node scripts/inspect-pdf.mjs <file.pdf>
// 出力にはページ構成・フォント・画像・色空間の情報が含まれる。本文のテキストは出力しない。
import { readFileSync } from 'node:fs';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream } from '@cantoo/pdf-lib';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/inspect-pdf.mjs <file.pdf>');
  process.exit(1);
}

const bytes = readFileSync(path);
const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
const ctx = doc.context;
const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const mm = (pt) => `${((pt * 25.4) / 72).toFixed(1)}mm`;
const box = (b) => (b ? `${mm(b.width)} x ${mm(b.height)} @(${mm(b.x)}, ${mm(b.y)})` : '-');

console.log(`file: ${path} (${bytes.length} bytes)`);
console.log(`header: ${new TextDecoder().decode(bytes.slice(0, 8))}  encrypted: ${doc.isEncrypted}`);
const info = ['Producer', 'Creator'].map((k) => `${k}=${lookup(ctx.lookup(ctx.trailerInfo.Info)?.get?.(PDFName.of(k)))?.decodeText?.() ?? '-'}`);
console.log(`info: ${info.join('  ')}`);
console.log(`pages: ${doc.getPageCount()}`);

const fonts = new Map();
const images = new Map();
const colorOps = new Map();

function collectResources(resources, where) {
  resources = lookup(resources);
  if (!(resources instanceof PDFDict)) return;
  const fontDict = lookup(resources.get(PDFName.of('Font')));
  if (fontDict instanceof PDFDict) {
    for (const [name, ref] of fontDict.entries()) {
      const key = ref.toString();
      if (fonts.has(key)) continue;
      const font = lookup(ref);
      const subtype = font.get(PDFName.of('Subtype'))?.toString();
      const base = font.get(PDFName.of('BaseFont'))?.toString();
      const encoding = lookup(font.get(PDFName.of('Encoding')))?.toString?.() ?? '-';
      let desc = lookup(font.get(PDFName.of('FontDescriptor')));
      let cidType = '';
      const descendants = lookup(font.get(PDFName.of('DescendantFonts')));
      if (descendants instanceof PDFArray) {
        const cid = lookup(descendants.get(0));
        cidType = cid.get(PDFName.of('Subtype'))?.toString() ?? '';
        desc = lookup(cid.get(PDFName.of('FontDescriptor')));
      }
      const embedded = desc instanceof PDFDict
        ? ['FontFile', 'FontFile2', 'FontFile3'].find((k) => desc.has(PDFName.of(k))) ?? 'NOT EMBEDDED'
        : 'no descriptor';
      const toUnicode = font.has(PDFName.of('ToUnicode'));
      fonts.set(key, { where, name: name.toString(), subtype, cidType, base, encoding, embedded, toUnicode });
    }
  }
  const xobjects = lookup(resources.get(PDFName.of('XObject')));
  if (xobjects instanceof PDFDict) {
    for (const [name, ref] of xobjects.entries()) {
      const key = ref.toString();
      if (images.has(key)) continue;
      const xo = lookup(ref);
      if (!(xo instanceof PDFStream)) continue;
      const dict = xo.dict;
      const subtype = dict.get(PDFName.of('Subtype'))?.toString();
      if (subtype === '/Image') {
        const cs = lookup(dict.get(PDFName.of('ColorSpace')));
        const csText = cs instanceof PDFArray ? `[${cs.asArray().map((x) => { const v = lookup(x); return v instanceof PDFStream ? `stream(N=${v.dict.get(PDFName.of('N'))})` : v?.toString(); }).join(' ')}]` : cs?.toString();
        images.set(key, {
          where,
          name: name.toString(),
          w: dict.get(PDFName.of('Width'))?.toString(),
          h: dict.get(PDFName.of('Height'))?.toString(),
          bpc: dict.get(PDFName.of('BitsPerComponent'))?.toString(),
          cs: csText,
          filter: lookup(dict.get(PDFName.of('Filter')))?.toString(),
          smask: dict.has(PDFName.of('SMask')),
          bytes: xo instanceof PDFRawStream ? xo.contents.length : '?',
        });
      } else if (subtype === '/Form') {
        images.set(key, { where, name: name.toString(), form: true, group: dict.has(PDFName.of('Group')) });
        collectResources(dict.get(PDFName.of('Resources')), `${where} > form ${name}`);
      }
    }
  }
  const gs = lookup(resources.get(PDFName.of('ExtGState')));
  if (gs instanceof PDFDict) {
    for (const [name, ref] of gs.entries()) {
      const g = lookup(ref);
      const keys = [...g.keys()].map((k) => k.toString()).join(' ');
      console.log(`  extgstate ${where} ${name}: ${keys} CA=${g.get(PDFName.of('CA')) ?? '-'} ca=${g.get(PDFName.of('ca')) ?? '-'} SMask=${g.get(PDFName.of('SMask')) ?? '-'}`);
    }
  }
}

doc.getPages().forEach((page, i) => {
  const rot = page.getRotation().angle;
  console.log(`\n[page ${i + 1}] rotate=${rot}`);
  console.log(`  MediaBox: ${box(page.getMediaBox())}`);
  for (const [label, key] of [['CropBox', 'CropBox'], ['BleedBox', 'BleedBox'], ['TrimBox', 'TrimBox'], ['ArtBox', 'ArtBox']]) {
    if (page.node.has(PDFName.of(key))) console.log(`  ${label}: ${box(page[`get${label}`]())}`);
  }
  const annots = lookup(page.node.get(PDFName.of('Annots')));
  console.log(`  annots: ${annots instanceof PDFArray ? annots.size() : 0}  group: ${page.node.has(PDFName.of('Group'))}`);
  collectResources(page.node.Resources(), `p${i + 1}`);

  // 色指定の演算子を数える(rg/RG = RGB、k/K = CMYK、g/G = グレー、sc/scn = 色空間指定)
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(lookup) : [lookup(contents)];
  for (const s of streams) {
    if (!(s instanceof PDFStream)) continue;
    let text;
    try {
      text = new TextDecoder('latin1').decode(s instanceof PDFRawStream ? decode(s) : s.getContents());
    } catch {
      continue;
    }
    for (const op of ['rg', 'RG', 'k', 'K', 'g', 'G', 'sc', 'scn', 'SC', 'SCN', 'cs', 'CS', 'BI', 'sh']) {
      const n = (text.match(new RegExp(String.raw`[\s\]]${op}[\s\n]`, 'g')) ?? []).length;
      if (n) colorOps.set(op, (colorOps.get(op) ?? 0) + n);
    }
  }
});

function decode(stream) {
  // pdf-lib の decodePDFRawStream を使う
  return decodePDFRawStream(stream).decode();
}

console.log('\nfonts:');
for (const f of fonts.values()) console.log(`  ${f.where} ${f.name} ${f.subtype}${f.cidType ? `/${f.cidType}` : ''} ${f.base} enc=${f.encoding} ${f.embedded} ToUnicode=${f.toUnicode}`);
console.log('\nxobjects:');
for (const x of images.values()) {
  if (x.form) console.log(`  ${x.where} ${x.name} Form group=${x.group}`);
  else console.log(`  ${x.where} ${x.name} ${x.w}x${x.h} bpc=${x.bpc} cs=${x.cs} filter=${x.filter} smask=${x.smask} bytes=${x.bytes}`);
}
console.log('\ncolor operators:', Object.fromEntries(colorOps));
