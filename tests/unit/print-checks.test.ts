import { describe, expect, it } from 'vitest';
import { runChecks, type CheckOptions, type PageFacts } from '../../src/print/checks.ts';
import type { SideStats } from '../../src/print/edges.ts';
import { mmToPt, rect } from '../../src/print/geometry.ts';
import { findPaperSize } from '../../src/print/paperSizes.ts';
import { findProfile } from '../../src/print/profiles.ts';
import type { ImagePlacement, PageStructure } from '../../src/print/structure.ts';

function structure(wMm: number, hMm: number, extra: Partial<PageStructure> = {}): PageStructure {
  const box = rect(0, 0, mmToPt(wMm), mmToPt(hMm));
  return {
    index: 0,
    mediaBox: box,
    cropBox: box,
    rotation: 0,
    fonts: [],
    annotations: { links: 0, widgets: 0, others: 0 },
    images: [],
    colorUse: { rgb: 0, cmyk: 0, gray: 0, spot: 0, other: 0 },
    transparency: false,
    ...extra,
  };
}

const edges = (missing: Partial<Record<SideStats['side'], number>> = {}): SideStats[] =>
  (['top', 'right', 'bottom', 'left'] as const).map((side) => ({
    side,
    samples: 100,
    inkAtTrim: missing[side] ?? 0,
    missingBleed: missing[side] ?? 0,
  }));

const opts = (over: Partial<CheckOptions> = {}): CheckOptions => ({
  profile: findProfile('tcpc'),
  paper: 'auto',
  binding: 'none',
  ...over,
});

const codes = (facts: PageFacts[], o = opts()) => runChecks(facts, o).findings.map((f) => f.code);

function imageAt(xMm: number, yMm: number, wMm: number, hMm: number, dpi: number): ImagePlacement {
  return {
    name: 'Im',
    pixelWidth: Math.round((wMm / 25.4) * dpi),
    pixelHeight: Math.round((hMm / 25.4) * dpi),
    bounds: rect(mmToPt(xMm), mmToPt(yMm), mmToPt(xMm + wMm), mmToPt(yMm + hMm)),
    dpi,
    color: 'rgb',
    isMask: false,
  };
}

describe('runChecks: サイズと塗り足し', () => {
  it('塗り足し込みの A5 で端も問題なければ、指摘はない', () => {
    expect(codes([{ structure: structure(154, 216), edges: edges() }])).toEqual([]);
  });

  it('塗り足しなしで端まで色があれば PRINT_NO_BLEED(辺と必要なサイズを示す)', () => {
    const report = runChecks([{ structure: structure(148, 210), edges: edges({ top: 80, left: 50 }) }], opts());
    const f = report.findings.find((x) => x.code === 'PRINT_NO_BLEED')!;
    expect(f.severity).toBe('error');
    expect(f.detail).toContain('上・左');
    expect(f.detail).toContain('154×216mm');
  });

  it('塗り足しなし・端が白ければ指摘しない(白いフチのデザイン)', () => {
    expect(codes([{ structure: structure(148, 210), edges: edges() }])).toEqual([]);
  });

  it('塗り足し込みでも、塗り足しが白く抜けていれば PRINT_WHITE_EDGE', () => {
    const report = runChecks([{ structure: structure(154, 216), edges: edges({ right: 30 }) }], opts());
    expect(report.findings.map((f) => f.code)).toEqual(['PRINT_WHITE_EDGE']);
    expect(report.findings[0].detail).toContain('右');
  });

  it('わずかな箇所(1% 以下)は指摘しない', () => {
    expect(codes([{ structure: structure(154, 216), edges: edges({ right: 1 }) }])).toEqual([]);
  });

  it('回転したページでは、画面上の向きで辺を示す', () => {
    const report = runChecks([{ structure: structure(148, 210, { rotation: 90 }), edges: edges({ top: 80 }) }], opts());
    expect(report.findings[0].detail).toContain('右');
  });

  it('判定できないサイズは PRINT_SIZE_UNKNOWN、サイズ指定と合わなければ PRINT_SIZE_MISMATCH', () => {
    expect(codes([{ structure: structure(160, 230) }])).toEqual(['PRINT_SIZE_UNKNOWN']);
    const a4 = findPaperSize('A4')!;
    const report = runChecks([{ structure: structure(154, 216) }], opts({ paper: a4 }));
    expect(report.findings[0].code).toBe('PRINT_SIZE_MISMATCH');
    expect(report.findings[0].detail).toContain('216×303mm');
  });

  it('ページごとに大きさが違えば PRINT_MIXED_SIZES', () => {
    expect(codes([{ structure: structure(154, 216) }, { structure: structure(216, 303) }])).toContain('PRINT_MIXED_SIZES');
  });

  it('仕上がりは同じでも、塗り足しの有無でページの大きさが違えば PRINT_MIXED_SIZES', () => {
    expect(codes([{ structure: structure(154, 216) }, { structure: structure(148, 210) }])).toContain('PRINT_MIXED_SIZES');
  });
});

describe('runChecks: 文字の位置', () => {
  const a5bleed = () => structure(154, 216);
  const box = (x0: number, y0: number, x1: number, y1: number, text = 'テキスト') => ({
    text,
    rect: rect(mmToPt(x0), mmToPt(y0), mmToPt(x1), mmToPt(y1)),
  });

  it('安全領域の内側なら問題なし', () => {
    // 東京カラー印刷: 仕上がり(3mm 内側)からさらに 3mm → ページ端から 6mm
    expect(codes([{ structure: a5bleed(), textBoxes: [box(10, 10, 60, 15)] }])).toEqual([]);
  });

  it('仕上がり線から安全領域までの間なら WARN', () => {
    const report = runChecks([{ structure: a5bleed(), textBoxes: [box(4, 100, 30, 105, '会場のご案内')] }], opts());
    const f = report.findings[0];
    expect(f.code).toBe('PRINT_TEXT_IN_UNSAFE_AREA');
    expect(f.severity).toBe('warn');
    expect(f.detail).toContain('「会場のご案内」');
    expect(f.marks).toHaveLength(1);
  });

  it('仕上がり線をまたげば ERROR', () => {
    expect(codes([{ structure: a5bleed(), textBoxes: [box(1, 100, 30, 105)] }])).toEqual(['PRINT_TEXT_OUTSIDE_TRIM']);
  });

  it('安全領域の幅は印刷所プロファイルに従う(汎用は 5mm)', () => {
    const facts = [{ structure: a5bleed(), textBoxes: [box(7, 100, 30, 105)] }];
    expect(codes(facts, opts({ profile: findProfile('tcpc') }))).toEqual([]);
    expect(codes(facts, opts({ profile: findProfile('generic') }))).toEqual(['PRINT_TEXT_IN_UNSAFE_AREA']);
  });
});

describe('runChecks: フォント・画像・その他', () => {
  it('埋め込まれていないフォントは ERROR で名前を示す', () => {
    const s = structure(154, 216, {
      fonts: [
        { name: 'MeiryoUI', subtype: 'Type0', embedded: true },
        { name: 'Helvetica', subtype: 'Type1', embedded: false },
      ],
    });
    const report = runChecks([{ structure: s }], opts());
    expect(report.findings[0]).toMatchObject({ code: 'PRINT_FONT_NOT_EMBEDDED', severity: 'error' });
    expect(report.findings[0].detail).toContain('Helvetica');
    expect(report.fonts).toEqual(['Helvetica', 'MeiryoUI']);
  });

  it('画像の解像度: 150ppi 未満は WARN、推奨未満は INFO、推奨以上は指摘なし', () => {
    const s = structure(154, 216, {
      images: [imageAt(10, 10, 60, 40, 120), imageAt(10, 60, 60, 40, 200), imageAt(10, 110, 60, 40, 360)],
    });
    const report = runChecks([{ structure: s }], opts());
    expect(report.findings.map((f) => [f.code, f.severity])).toEqual([
      ['PRINT_IMAGE_LOW_DPI', 'warn'],
      ['PRINT_IMAGE_BELOW_RECOMMENDED', 'info'],
    ]);
    expect(report.findings[1].detail).toContain('350ppi');
  });

  it('小さな画像(模様・アイコン)と、仕上がりの外にある画像は解像度を問わない', () => {
    const s = structure(154, 216, { images: [imageAt(10, 10, 8, 8, 50), imageAt(200, 10, 40, 40, 50)] });
    expect(codes([{ structure: s }])).toEqual([]);
  });

  it('極端によく圧縮される画像(単色の塗り・なめらかなグラデーション)は解像度を問わない', () => {
    // 50×50px を 60mm 角に引き伸ばした画像(約 21ppi)。圧縮後 30 バイト → 平坦とみなす
    const flat = { ...imageAt(10, 10, 60, 60, 21), pixelWidth: 50, pixelHeight: 50, encodedBytes: 30 };
    // 同じ大きさでも、圧縮後 4000 バイト(写真のような画像)なら指摘する
    const photo = { ...flat, encodedBytes: 4000 };
    expect(codes([{ structure: structure(154, 216, { images: [flat] }) }])).toEqual([]);
    expect(codes([{ structure: structure(154, 216, { images: [photo] }) }])).toEqual(['PRINT_IMAGE_LOW_DPI']);
  });

  it('中綴じでページ数が 4 の倍数でなければ ERROR(足りないページ数を示す)', () => {
    const facts = Array.from({ length: 6 }, () => ({ structure: structure(154, 216) }));
    const report = runChecks(facts, opts({ binding: 'saddle' }));
    expect(report.findings[0].code).toBe('PRINT_PAGE_COUNT_SADDLE');
    expect(report.findings[0].detail).toContain('あと 2 ページ');
    expect(codes(facts.slice(0, 4), opts({ binding: 'saddle' }))).toEqual([]);
  });

  it('注釈・フォームは WARN、リンクは指摘しない', () => {
    expect(codes([{ structure: structure(154, 216, { annotations: { links: 3, widgets: 0, others: 0 } }) }])).toEqual([]);
    expect(codes([{ structure: structure(154, 216, { annotations: { links: 0, widgets: 1, others: 2 } }) }])).toEqual([
      'PRINT_HAS_ANNOTATIONS',
      'PRINT_HAS_FORM_FIELDS',
    ]);
  });

  it('くすみ: 大きくくすむ色が面積の 5% 以上なら WARN、少しなら INFO、わずかなら指摘しない', () => {
    const facts = (moderate: number, strong: number): PageFacts[] => [
      { structure: structure(154, 216), gamut: { pixels: 10000, moderate, strong } },
    ];
    const warn = runChecks(facts(1200, 600), opts()).findings[0];
    expect(warn).toMatchObject({ code: 'PRINT_COLOR_DULL', severity: 'warn' });
    expect(warn.detail).toContain('約 12%');
    expect(warn.detail).toContain('大きくくすむ所 約 6%');
    expect(runChecks(facts(300, 0), opts()).findings[0]).toMatchObject({ code: 'PRINT_COLOR_DULL', severity: 'info' });
    expect(codes(facts(20, 0))).toEqual([]);
  });

  it('RGB と透明効果は INFO', () => {
    const s = structure(154, 216, { colorUse: { rgb: 5, cmyk: 0, gray: 0, spot: 0, other: 0 }, transparency: true });
    const report = runChecks([{ structure: s }], opts());
    expect(report.findings.map((f) => [f.code, f.severity])).toEqual([
      ['PRINT_RGB_CONTENT', 'info'],
      ['PRINT_TRANSPARENCY', 'info'],
    ]);
  });

  it('指摘は重大度の順(error → warn → info)に並ぶ', () => {
    const s = structure(148, 210, {
      colorUse: { rgb: 1, cmyk: 0, gray: 0, spot: 0, other: 0 },
      annotations: { links: 0, widgets: 0, others: 1 },
    });
    const report = runChecks([{ structure: s, edges: edges({ top: 50 }) }], opts());
    expect(report.findings.map((f) => f.severity)).toEqual(['error', 'warn', 'info']);
  });
});
