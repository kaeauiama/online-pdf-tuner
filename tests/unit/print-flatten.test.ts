import { describe, expect, it } from 'vitest';
import { lexContent } from '../../src/pdf/lexer.ts';
import { flattenScale, MAX_FLATTEN_PIXELS, splitTextLayers, type GsInfo } from '../../src/print/flatten.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const opsOf = (b: Uint8Array) => lexContent(b).map((o) => o.op);
const textShows = (b: Uint8Array) => opsOf(b).filter((o) => o === 'Tj' || o === 'TJ' || o === "'");

const PAGE = `q 1 0 0 rg 0 0 100 100 re f Q
q /Half gs 0 0 1 rg 10 10 50 50 re f Q
q 10 10 80 80 re W n 80 0 0 80 10 10 cm /Im1 Do Q
BT /F1 12 Tf 20 20 Td (Hello) Tj [(W) -50 (orld)] TJ (next) ' ET
/Sh1 sh`;

const GS: Record<string, GsInfo> = {
  Half: { fillAlpha: 0.5, strokeAlpha: 0.5 },
  Clear: { fillAlpha: 0 },
  ClearStroke: { strokeAlpha: 0 },
  Mask: { softMask: true },
};
const gs = (name: string) => GS[name];

describe('splitTextLayers: 図形と画像', () => {
  const layers = splitTextLayers(enc(PAGE), gs);

  it('文字以外の層: 不透明な文字の表示だけを除き、図形・画像・グラデーション・透明の指定は残す', () => {
    const ops = opsOf(layers.noText);
    expect(textShows(layers.noText)).toEqual([]);
    expect(ops).toEqual(expect.arrayContaining(['f', 'Do', 'sh', 'gs', 'BT', 'Tf', 'Td', 'ET']));
    // ' は行送りの T* に置き換える
    expect(ops).toContain('T*');
  });

  it('文字だけの層: 塗りを n に変え、画像・グラデーション・透明の指定を除き、文字とクリップは残す', () => {
    const ops = opsOf(layers.textOnly);
    expect(ops).not.toContain('f');
    expect(ops).not.toContain('Do');
    expect(ops).not.toContain('sh');
    expect(ops).not.toContain('gs');
    expect(textShows(layers.textOnly)).toHaveLength(3);
    expect(ops).toContain('W');
    expect(ops).toEqual(expect.arrayContaining(['rg', 'cm', 'q', 'Q', 'Tf', 'Td']));
  });

  it('数を数える', () => {
    expect(layers.vectorText).toBe(3);
    expect(layers.invisibleText).toBe(0);
    expect(layers.rasterizedText).toBe(0);
    expect(layers.xobjects).toBe(1);
  });

  it('インライン画像は文字だけの層から除く', () => {
    const t = splitTextLayers(enc('q BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q BT (x) Tj ET'));
    expect(opsOf(t.textOnly)).toEqual(['q', 'Q', 'BT', 'Tr', 'Tj', 'ET']);
  });
});

describe('splitTextLayers: 文字の不透明度と描画モード', () => {
  it('完全に透明な文字(Office の検索用の文字)は、描画モード 3 の見えない文字にして文字の層に残す', () => {
    // PowerPoint の出力と同じ形: 塗りと線(Tr 2)の両方を不透明度 0 にした文字
    const t = splitTextLayers(enc('q BT /F1 12 Tf 2 Tr /Clear gs 0 g /ClearStroke gs 0 G (070) Tj ET Q'), gs);
    expect(t.invisibleText).toBe(1);
    expect(textShows(t.noText)).toEqual([]);
    expect(dec(t.textOnly)).toContain('3 Tr <303730> Tj');
    expect(opsOf(t.textOnly)).not.toContain('gs');
  });

  it('半透明の文字は、効果ごと画像の層に残し、文字の層からは除く', () => {
    const t = splitTextLayers(enc('q /Half gs BT /F1 12 Tf (Ghost) Tj ET Q'), gs);
    expect(t.rasterizedText).toBe(1);
    expect(textShows(t.noText)).toEqual(['Tj']);
    expect(textShows(t.textOnly)).toEqual([]);
  });

  it('ソフトマスクの付いた文字も、画像の層に焼き込む', () => {
    const t = splitTextLayers(enc('q /Mask gs BT (Soft) Tj ET Q BT (Plain) Tj ET'), gs);
    expect(t.rasterizedText).toBe(1);
    expect(t.vectorText).toBe(1);
  });

  it('q / Q で不透明度が元に戻る', () => {
    const t = splitTextLayers(enc('q /Clear gs BT (a) Tj ET Q BT (b) Tj ET'), gs);
    expect(t.invisibleText).toBe(1);
    expect(t.vectorText).toBe(2);
    expect(dec(t.textOnly)).toContain('0 Tr <62> Tj');
  });

  it('塗りだけ透明でも、線(Tr 1)で描く文字は見えるので文字の層に残す', () => {
    const t = splitTextLayers(enc('BT 1 Tr /Clear gs (Outline) Tj ET'), gs);
    expect(t.invisibleText).toBe(0);
    expect(dec(t.textOnly)).toContain('1 Tr');
  });
});

describe('flattenScale', () => {
  it('解像度から倍率を決める', () => {
    expect(flattenScale(595, 842, 350)).toEqual({ scale: 350 / 72, dpi: 350 });
  });

  it('画素数の上限を超えるときは解像度を下げる', () => {
    const r = flattenScale(1460, 2064, 600);
    expect(r.dpi).toBeLessThan(600);
    expect(1460 * r.scale * 2064 * r.scale).toBeLessThanOrEqual(MAX_FLATTEN_PIXELS + 1);
  });
});
