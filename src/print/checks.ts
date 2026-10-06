// 入稿チェック本体(純粋関数)。ページごとの事実と設定から、指摘の一覧を作る。
import type { SideStats } from './edges.ts';
import { displayedSide } from './edges.ts';
import type { GamutStats } from './gamut.ts';
import { containsRect, intersects, mmToPt, ptToMm, rect, rectHeight, rectWidth, type Rect } from './geometry.ts';
import { resolveLayout, type PageLayout, type PaperChoice } from './layout.ts';
import { formatSize } from './paperSizes.ts';
import type { PrintProfile } from './profiles.ts';
import type { ImagePlacement, PageStructure, PaintNote, PaintNoteKind } from './structure.ts';
import type { TextBox } from './textBoxes.ts';
import {
  EDGE_PROBLEM_RATIO,
  FLAT_IMAGE_COMPRESSION_RATIO,
  GAMUT_INFO_AREA_RATIO,
  GAMUT_WARN_AREA_RATIO,
  LOW_DPI_WARN,
  MIN_IMAGE_AREA_MM2,
  MIN_IMAGE_PIXELS,
  INK_LIMIT_PERCENT,
  SMALL_TEXT_PT,
  TEXT_TOLERANCE_PT,
  THIN_LINE_MM,
} from './thresholds.ts';

export type Severity = 'error' | 'warn' | 'info';

export type PrintCode =
  | 'PRINT_SIZE_UNKNOWN'
  | 'PRINT_SIZE_MISMATCH'
  | 'PRINT_MIXED_SIZES'
  | 'PRINT_BLEED_TOO_SMALL'
  | 'PRINT_NO_BLEED'
  | 'PRINT_WHITE_EDGE'
  | 'PRINT_TEXT_OUTSIDE_TRIM'
  | 'PRINT_TEXT_IN_UNSAFE_AREA'
  | 'PRINT_FONT_NOT_EMBEDDED'
  | 'PRINT_IMAGE_LOW_DPI'
  | 'PRINT_IMAGE_BELOW_RECOMMENDED'
  | 'PRINT_PAGE_COUNT_SADDLE'
  | 'PRINT_HAS_ANNOTATIONS'
  | 'PRINT_HAS_FORM_FIELDS'
  | 'PRINT_COLOR_DULL'
  | 'PRINT_RGB_CONTENT'
  | 'PRINT_TRANSPARENCY'
  | 'PRINT_LINE_ZERO_WIDTH'
  | 'PRINT_LINE_TOO_THIN'
  | 'PRINT_FILL_ONLY_LINE'
  | 'PRINT_WHITE_OVERPRINT'
  | 'PRINT_SMALL_TEXT'
  | 'PRINT_RICH_BLACK_TEXT'
  | 'PRINT_INK_OVER_LIMIT'
  | 'PRINT_SPOT_COLOR'
  | 'PRINT_REGISTRATION_COLOR'
  | 'PRINT_HIDDEN_LAYER';

/** 指摘の対象の場所(プレビューで、選んだ指摘の対象を示すのに使う) */
export interface Mark {
  readonly page: number;
  readonly rect: Rect;
  readonly kind: 'text' | 'image' | 'object' | 'area';
  /** 場所ごとの説明(文字の内容・線幅など) */
  readonly label?: string;
}

export interface Finding {
  readonly code: PrintCode;
  readonly severity: Severity;
  /** 対象ページ(0 始まり) */
  readonly pages: readonly number[];
  /** このファイル固有の詳細(何が・どこで・どれくらい) */
  readonly detail: string;
  readonly marks: readonly Mark[];
}

export interface PageFacts {
  readonly structure: PageStructure;
  readonly textBoxes?: readonly TextBox[];
  readonly edges?: readonly SideStats[];
  /** くすみ警告用: 仕上がりの内側の画素の集計 */
  readonly gamut?: GamutStats;
  /** 白いフチを除いた中身の範囲(pt、ページ座標)。入稿修正で使う */
  readonly contentBounds?: Rect;
}

export type Binding = 'none' | 'saddle';

export interface CheckOptions {
  readonly profile: PrintProfile;
  readonly paper: PaperChoice;
  readonly binding: Binding;
}

export interface PrintReport {
  readonly layouts: readonly PageLayout[];
  readonly findings: readonly Finding[];
  /** 使われているフォント名(重複なし) */
  readonly fonts: readonly string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
const SIDE_LABEL = { top: '上', right: '右', bottom: '下', left: '左' } as const;

const pageList = (pages: readonly number[]) => pages.map((p) => p + 1).join(', ');

function sizeOf(r: Rect): string {
  return formatSize(ptToMm(rectWidth(r)), ptToMm(rectHeight(r)));
}

/** 単色の塗りやなめらかなグラデーションの画像(解像度が見た目に影響しない) */
function isFlatImage(img: ImagePlacement): boolean {
  if (img.encodedBytes === undefined || img.encodedBytes === 0) return false;
  const components = img.color === 'cmyk' ? 4 : img.color === 'gray' ? 1 : 3;
  return (img.pixelWidth * img.pixelHeight * components) / img.encodedBytes > FLAT_IMAGE_COMPRESSION_RATIO;
}

/** 辺に沿った帯(端の色の指摘の場所)。inside: 仕上がりの内側の帯 / bleed: 塗り足しの帯 */
function sideBand(l: PageLayout, side: 'top' | 'right' | 'bottom' | 'left', band: 'inside' | 'bleed', bleedMm: number): Rect {
  const t = l.trim;
  const o = l.bleed;
  const w = mmToPt(bleedMm);
  switch (side) {
    case 'top':
      return band === 'inside' ? rect(t.x0, t.y1 - w, t.x1, t.y1) : rect(o.x0, t.y1, o.x1, o.y1);
    case 'bottom':
      return band === 'inside' ? rect(t.x0, t.y0, t.x1, t.y0 + w) : rect(o.x0, o.y0, o.x1, t.y0);
    case 'left':
      return band === 'inside' ? rect(t.x0, t.y0, t.x0 + w, t.y1) : rect(o.x0, o.y0, t.x0, o.y1);
    case 'right':
      return band === 'inside' ? rect(t.x1 - w, t.y0, t.x1, t.y1) : rect(t.x1, o.y0, o.x1, o.y1);
  }
}

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 12 ? `${t.slice(0, 12)}…` : t;
}

export function runChecks(pages: readonly PageFacts[], options: CheckOptions): PrintReport {
  const { profile, paper, binding } = options;
  const layouts = pages.map((p) => resolveLayout(p.structure, profile, paper));
  const findings: Finding[] = [];
  const add = (code: PrintCode, severity: Severity, pageIndexes: readonly number[], detail: string, marks: readonly Mark[] = []) =>
    findings.push({ code, severity, pages: pageIndexes, detail, marks });
  /** 構造の解析で見つけた描画の注意を、場所の一覧にする(仕上がりの外だけのものは除く。トンボなどのため) */
  const noteMarks = (kind: PaintNoteKind, markKind: Mark['kind'], label: (n: PaintNote) => string, onlyInTrim = true): Mark[] =>
    pages.flatMap((p, i) =>
      p.structure.notes
        .filter((n) => n.kind === kind && (!onlyInTrim || intersects(n.bounds, layouts[i].trim)))
        .map((n) => ({ page: i, rect: n.bounds, kind: markKind, label: label(n) })),
    );
  const pagesOf = (marks: readonly Mark[]) => [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);
  const countDetail = (marks: readonly Mark[], unit = 'か所') => `${marks.length} ${unit}(${pageList(pagesOf(marks))} ページ目)`;

  // ---- サイズ ----
  const unknown = layouts.flatMap((l, i) => (l.kind === 'unknown' ? [i] : []));
  if (unknown.length > 0) {
    const sizes = [...new Set(unknown.map((i) => sizeOf(layouts[i].page)))].join('、');
    if (paper === 'auto') {
      add('PRINT_SIZE_UNKNOWN', 'warn', unknown, `ページの大きさは ${sizes} です。`);
    } else {
      const b = profile.bleedMm * 2;
      add(
        'PRINT_SIZE_MISMATCH',
        'error',
        unknown,
        `${paper.label} の仕上がりは ${formatSize(paper.widthMm, paper.heightMm)}(塗り足し込みなら ${formatSize(paper.widthMm + b, paper.heightMm + b)})ですが、ページの大きさは ${sizes} です。`,
      );
    }
  }

  // 塗り足しの有無が違う場合も含めて、ページの大きさそのものがそろっているかを見る
  const pageSizes = new Set(layouts.map((l) => sizeOf(l.page)));
  if (pageSizes.size > 1) {
    add('PRINT_MIXED_SIZES', 'warn', layouts.map((_, i) => i), `ページの大きさが ${[...pageSizes].join('、')} と混在しています。`);
  }

  const smallBleed = layouts.flatMap((l, i) => (l.bleedMm > 0 && l.bleedMm < profile.bleedMm - 0.3 ? [i] : []));
  if (smallBleed.length > 0) {
    const min = Math.min(...smallBleed.map((i) => layouts[i].bleedMm));
    add('PRINT_BLEED_TOO_SMALL', 'warn', smallBleed, `塗り足しが ${min.toFixed(1)}mm しかありません(この印刷所の目安は ${profile.bleedMm}mm)。`);
  }

  // ---- 端の色(塗り足し) ----
  const noBleed: { page: number; sides: string[] }[] = [];
  const whiteEdge: { page: number; sides: string[] }[] = [];
  pages.forEach((p, i) => {
    if (!p.edges) return;
    const sides = p.edges
      .filter((s) => s.samples > 0 && s.missingBleed / s.samples > EDGE_PROBLEM_RATIO)
      .map((s) => SIDE_LABEL[displayedSide(s.side, p.structure.rotation)]);
    if (sides.length === 0) return;
    (layouts[i].bleedMm === 0 ? noBleed : whiteEdge).push({ page: i, sides });
  });
  const describeSides = (items: { page: number; sides: string[] }[]) =>
    items.map((x) => `${x.page + 1} ページ目の${x.sides.join('・')}`).join('、');
  const edgeMarks = (items: { page: number; sides: string[] }[], band: 'inside' | 'bleed'): Mark[] =>
    items.flatMap((x) =>
      (pages[x.page].edges ?? [])
        .filter((s) => s.samples > 0 && s.missingBleed / s.samples > EDGE_PROBLEM_RATIO)
        .map((s) => ({
          page: x.page,
          rect: sideBand(layouts[x.page], s.side, band, profile.bleedMm),
          kind: 'area' as const,
          label: `${SIDE_LABEL[displayedSide(s.side, pages[x.page].structure.rotation)]}の端`,
        })),
    );
  if (noBleed.length > 0) {
    const l = layouts[noBleed[0].page];
    const target = l.paper
      ? `(${l.paper.label} なら ${formatSize((l.landscape ? l.paper.heightMm : l.paper.widthMm) + profile.bleedMm * 2, (l.landscape ? l.paper.widthMm : l.paper.heightMm) + profile.bleedMm * 2)})`
      : '';
    add(
      'PRINT_NO_BLEED',
      'error',
      noBleed.map((x) => x.page),
      `${describeSides(noBleed)}の端まで色がありますが、塗り足しがありません。塗り足し込みのサイズ${target}にする必要があります。`,
      edgeMarks(noBleed, 'inside'),
    );
  }
  if (whiteEdge.length > 0) {
    add('PRINT_WHITE_EDGE', 'error', whiteEdge.map((x) => x.page), `${describeSides(whiteEdge)}で、仕上がり線の外側(塗り足し)が白く抜けています。`, edgeMarks(whiteEdge, 'bleed'));
  }

  // ---- 文字の位置 ----
  const outside: Mark[] = [];
  const unsafe: Mark[] = [];
  const outsideTexts: string[] = [];
  const unsafeTexts: string[] = [];
  pages.forEach((p, i) => {
    const l = layouts[i];
    for (const box of p.textBoxes ?? []) {
      if (!intersects(box.rect, l.page)) continue; // ページの外(見えない文字)は対象外
      if (!containsRect(l.trim, box.rect, TEXT_TOLERANCE_PT)) {
        outside.push({ page: i, rect: box.rect, kind: 'text', label: `「${excerpt(box.text)}」` });
        outsideTexts.push(excerpt(box.text));
      } else if (!containsRect(l.safe, box.rect, TEXT_TOLERANCE_PT)) {
        unsafe.push({ page: i, rect: box.rect, kind: 'text', label: `「${excerpt(box.text)}」` });
        unsafeTexts.push(excerpt(box.text));
      }
    }
  });
  const textDetail = (marks: Mark[], texts: string[]) => {
    const samples = [...new Set(texts)].slice(0, 3).map((t) => `「${t}」`).join('');
    return `${samples}など ${marks.length} か所(${pageList([...new Set(marks.map((m) => m.page))])} ページ目)`;
  };
  if (outside.length > 0) {
    add('PRINT_TEXT_OUTSIDE_TRIM', 'error', [...new Set(outside.map((m) => m.page))], `${textDetail(outside, outsideTexts)}が、仕上がり線の外にはみ出しています。`, outside);
  }
  if (unsafe.length > 0) {
    add(
      'PRINT_TEXT_IN_UNSAFE_AREA',
      'warn',
      [...new Set(unsafe.map((m) => m.page))],
      `${textDetail(unsafe, unsafeTexts)}が、仕上がり線から ${profile.safeMarginMm}mm 以内にあります。`,
      unsafe,
    );
  }

  // ---- フォント ----
  const fontNames = new Set<string>();
  const notEmbedded = new Map<string, number[]>();
  pages.forEach((p, i) => {
    for (const f of p.structure.fonts) {
      fontNames.add(f.name);
      if (!f.embedded) notEmbedded.set(f.name, [...(notEmbedded.get(f.name) ?? []), i]);
    }
  });
  if (notEmbedded.size > 0) {
    const pagesWith = [...new Set([...notEmbedded.values()].flat())].sort((a, b) => a - b);
    add('PRINT_FONT_NOT_EMBEDDED', 'error', pagesWith, `埋め込まれていないフォント: ${[...notEmbedded.keys()].join('、')}`, noteMarks('unembedded-font', 'text', (n) => n.label ?? ''));
  }

  // ---- 画像の解像度 ----
  const low: { page: number; dpi: number; rect: Rect }[] = [];
  const belowRecommended: { page: number; dpi: number; rect: Rect }[] = [];
  pages.forEach((p, i) => {
    for (const img of p.structure.images) {
      if (img.isMask || img.pixelWidth * img.pixelHeight < MIN_IMAGE_PIXELS || isFlatImage(img)) continue;
      if (ptToMm(rectWidth(img.bounds)) * ptToMm(rectHeight(img.bounds)) < MIN_IMAGE_AREA_MM2) continue;
      if (!intersects(img.bounds, layouts[i].trim)) continue;
      const item = { page: i, dpi: img.dpi, rect: img.bounds };
      if (img.dpi < LOW_DPI_WARN) low.push(item);
      else if (img.dpi < profile.recommendedDpi - 0.5) belowRecommended.push(item);
    }
  });
  const dpiRange = (items: { dpi: number }[]) => {
    const values = items.map((x) => Math.round(x.dpi));
    const min = Math.min(...values);
    const max = Math.max(...values);
    return min === max ? `${min}ppi` : `${min}〜${max}ppi`;
  };
  const imageMarks = (items: { page: number; rect: Rect; dpi: number }[]): Mark[] =>
    items.map((x) => ({ page: x.page, rect: x.rect, kind: 'image', label: `約 ${Math.round(x.dpi)}ppi` }));
  if (low.length > 0) {
    add('PRINT_IMAGE_LOW_DPI', 'warn', [...new Set(low.map((x) => x.page))], `${low.length} 個(${dpiRange(low)})`, imageMarks(low));
  }
  if (belowRecommended.length > 0) {
    add(
      'PRINT_IMAGE_BELOW_RECOMMENDED',
      'info',
      [...new Set(belowRecommended.map((x) => x.page))],
      `${belowRecommended.length} 個(${dpiRange(belowRecommended)}。この印刷所の推奨は ${profile.recommendedDpi}ppi)`,
      imageMarks(belowRecommended),
    );
  }

  // ---- ページ数 ----
  if (binding === 'saddle' && pages.length % 4 !== 0) {
    const need = 4 - (pages.length % 4);
    add('PRINT_PAGE_COUNT_SADDLE', 'error', [], `いまは ${pages.length} ページです。あと ${need} ページ足すと ${pages.length + need} ページ(4 の倍数)になります。`);
  }

  // ---- 注釈・フォーム ----
  const annotated = pages.flatMap((p, i) => (p.structure.annotations.others > 0 ? [i] : []));
  if (annotated.length > 0) add('PRINT_HAS_ANNOTATIONS', 'warn', annotated, `${pageList(annotated)} ページ目`);
  const forms = pages.flatMap((p, i) => (p.structure.annotations.widgets > 0 ? [i] : []));
  if (forms.length > 0) add('PRINT_HAS_FORM_FIELDS', 'warn', forms, `${pageList(forms)} ページ目`);

  // ---- くすみ(S2) ----
  const dull: { page: number; moderate: number; strong: number }[] = [];
  pages.forEach((p, i) => {
    if (!p.gamut || p.gamut.pixels === 0) return;
    const moderate = p.gamut.moderate / p.gamut.pixels;
    const strong = p.gamut.strong / p.gamut.pixels;
    if (moderate >= GAMUT_INFO_AREA_RATIO) dull.push({ page: i, moderate, strong });
  });
  if (dull.length > 0) {
    const pct = (v: number) => (v < 0.01 ? '1% 未満' : `約 ${Math.round(v * 100)}%`);
    const severity: Severity = dull.some((d) => d.strong >= GAMUT_WARN_AREA_RATIO) ? 'warn' : 'info';
    const detail = dull
      .map((d) => `${d.page + 1} ページ目: 面積の${pct(d.moderate)}${d.strong >= 0.005 ? `(大きくくすむ所 ${pct(d.strong)})` : ''}`)
      .join('、');
    add('PRINT_COLOR_DULL', severity, dull.map((d) => d.page), detail);
  }

  // ---- 色・透明(情報) ----
  const rgb =pages.flatMap((p, i) => (p.structure.colorUse.rgb > 0 ? [i] : []));
  if (rgb.length > 0) add('PRINT_RGB_CONTENT', 'info', rgb, `${pageList(rgb)} ページ目`);
  const transparent = pages.flatMap((p, i) => (p.structure.transparency ? [i] : []));
  if (transparent.length > 0) {
    const invisible = transparent.filter((i) => pages[i].structure.fullyTransparent);
    const note =
      invisible.length > 0
        ? `。そのうち ${pageList(invisible)} ページ目には、完全に透明な文字や図形があります(PowerPoint などが、画像にした文字の上に、検索用の見えない文字を重ねていることがあります。透明に対応していない印刷機では、これが濃く印刷されて文字が二重に見えることがあります)`
        : '';
    add('PRINT_TRANSPARENCY', 'info', transparent, `${pageList(transparent)} ページ目${note}`, noteMarks('transparent', 'object', () => '透明効果'));
  }

  // ---- 線・オーバープリント・文字・インキ(D-033) ----
  const mm = (v: number | undefined) => `${(v ?? 0).toFixed(2)}mm`;
  const valuesOf = (kind: PaintNoteKind) => pages.flatMap((p) => p.structure.notes.filter((n) => n.kind === kind).map((n) => n.value ?? 0));
  const zero = noteMarks('zero-width-line', 'object', () => '線幅 0');
  if (zero.length > 0) add('PRINT_LINE_ZERO_WIDTH', 'error', pagesOf(zero), countDetail(zero, '本'), zero);
  const thin = noteMarks('thin-line', 'object', (n) => `線幅 約 ${mm(n.value)}`);
  if (thin.length > 0) {
    const min = Math.min(...valuesOf('thin-line'));
    add('PRINT_LINE_TOO_THIN', 'warn', pagesOf(thin), `${countDetail(thin, '本')}。いちばん細いもので約 ${mm(min)}(目安は ${THIN_LINE_MM}mm 以上)`, thin);
  }
  const fillOnly = noteMarks('fill-only-line', 'object', () => '塗りだけの線');
  if (fillOnly.length > 0) add('PRINT_FILL_ONLY_LINE', 'warn', pagesOf(fillOnly), countDetail(fillOnly, '本'), fillOnly);
  const whiteOp = noteMarks('white-overprint', 'object', () => '白のオーバープリント');
  if (whiteOp.length > 0) add('PRINT_WHITE_OVERPRINT', 'error', pagesOf(whiteOp), countDetail(whiteOp), whiteOp);
  const textLabel = (n: PaintNote) => `「${n.label ?? ''}」約 ${(n.value ?? 0).toFixed(1)}pt`;
  const small = noteMarks('small-text', 'text', textLabel);
  if (small.length > 0) add('PRINT_SMALL_TEXT', 'info', pagesOf(small), `${countDetail(small)}が、${SMALL_TEXT_PT}pt より小さい文字です。`, small);
  const richBlack = noteMarks('rich-black-text', 'text', textLabel);
  if (richBlack.length > 0) add('PRINT_RICH_BLACK_TEXT', 'warn', pagesOf(richBlack), countDetail(richBlack), richBlack);
  const ink = noteMarks('ink-over', 'object', (n) => `総インキ量 ${n.value ?? 0}%`);
  if (ink.length > 0) {
    const max = Math.max(...valuesOf('ink-over'));
    add('PRINT_INK_OVER_LIMIT', 'warn', pagesOf(ink), `${countDetail(ink)}。最大 ${max}%(目安は ${INK_LIMIT_PERCENT}% 以下)`, ink);
  }
  const registration = noteMarks('registration', 'object', () => 'レジストレーション');
  if (registration.length > 0) add('PRINT_REGISTRATION_COLOR', 'warn', pagesOf(registration), countDetail(registration), registration);
  const hiddenLayer = noteMarks('hidden-layer', 'object', () => '非表示のレイヤー', false);
  if (hiddenLayer.length > 0) add('PRINT_HIDDEN_LAYER', 'warn', pagesOf(hiddenLayer), countDetail(hiddenLayer), hiddenLayer);
  const spots = [...new Set(pages.flatMap((p) => p.structure.spotColors))];
  if (spots.length > 0) {
    const spotPages = pages.flatMap((p, i) => (p.structure.spotColors.length > 0 ? [i] : []));
    add('PRINT_SPOT_COLOR', 'info', spotPages, `特色: ${spots.join('、')}(${pageList(spotPages)} ページ目)`);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { layouts, findings, fonts: [...fontNames].sort() };
}
