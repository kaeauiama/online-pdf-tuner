// 入稿チェック本体(純粋関数)。ページごとの事実と設定から、指摘の一覧を作る。
import type { SideStats } from './edges.ts';
import { displayedSide } from './edges.ts';
import type { GamutStats } from './gamut.ts';
import { containsRect, intersects, ptToMm, rectHeight, rectWidth, type Rect } from './geometry.ts';
import { resolveLayout, type PageLayout, type PaperChoice } from './layout.ts';
import { formatSize } from './paperSizes.ts';
import type { PrintProfile } from './profiles.ts';
import type { ImagePlacement, PageStructure } from './structure.ts';
import type { TextBox } from './textBoxes.ts';
import {
  EDGE_PROBLEM_RATIO,
  FLAT_IMAGE_COMPRESSION_RATIO,
  GAMUT_INFO_AREA_RATIO,
  GAMUT_WARN_AREA_RATIO,
  LOW_DPI_WARN,
  MIN_IMAGE_AREA_MM2,
  MIN_IMAGE_PIXELS,
  TEXT_TOLERANCE_PT,
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
  | 'PRINT_TRANSPARENCY';

export interface Mark {
  readonly page: number;
  readonly rect: Rect;
  readonly kind: 'text' | 'image';
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
    );
  }
  if (whiteEdge.length > 0) {
    add('PRINT_WHITE_EDGE', 'error', whiteEdge.map((x) => x.page), `${describeSides(whiteEdge)}で、仕上がり線の外側(塗り足し)が白く抜けています。`);
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
        outside.push({ page: i, rect: box.rect, kind: 'text' });
        outsideTexts.push(excerpt(box.text));
      } else if (!containsRect(l.safe, box.rect, TEXT_TOLERANCE_PT)) {
        unsafe.push({ page: i, rect: box.rect, kind: 'text' });
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
    add('PRINT_FONT_NOT_EMBEDDED', 'error', pagesWith, `埋め込まれていないフォント: ${[...notEmbedded.keys()].join('、')}`);
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
  const imageMarks = (items: { page: number; rect: Rect }[]): Mark[] => items.map((x) => ({ page: x.page, rect: x.rect, kind: 'image' }));
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
  if (transparent.length > 0) add('PRINT_TRANSPARENCY', 'info', transparent, `${pageList(transparent)} ページ目`);

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { layouts, findings, fonts: [...fontNames].sort() };
}
