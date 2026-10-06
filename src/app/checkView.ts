// 入稿チェック画面。編集中のページを PDF に書き出して解析し、指摘とプレビューを表示する。
// 「入稿用 PDF を作る」(M3)では、塗り足し・トンボを付けた PDF を作り、それをもう一度チェックしてから保存させる。
import { makeBlankPdf } from '../core/blank.ts';
import { baseName, buildPdf, SourceCache } from '../core/build.ts';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { parsePageRanges } from '../core/ranges.ts';
import { analyzeForPrint, type PrintAnalysis } from '../print/analyze.ts';
import type { Binding, CheckOptions, Finding, Mark, Severity } from '../print/checks.ts';
import { blankPagesForSaddle, buildPrintReady, type BleedMethod, type FixResult, type RegionFit } from '../print/fix.ts';
import { adjustColors, type ColorMode, type ColorPageResult } from '../print/colorConvert.ts';
import { CMYK_LUT_SOURCE } from '../print/cmykLut.ts';
import { flattenPdf } from '../print/flattenRender.ts';
import { outlineText, type OutlineKeptReason, type OutlinePageResult } from '../print/outline.ts';
import { decodeJpegInBrowser } from '../render/jpeg.ts';
import { highlightOutOfGamut, maskFromRects, simulatePrint } from '../print/gamut.ts';
import { GAMUT_SOURCE } from '../print/gamutTable.ts';
import { mmToPt, ptToMm, rectArea, rectHeight, rectWidth, type Rect } from '../print/geometry.ts';
import type { PageLayout } from '../print/layout.ts';
import { PRINT_MESSAGES } from '../print/messages.ts';
import { findPaperSize, formatSize, PAPER_SIZES } from '../print/paperSizes.ts';
import { findProfile, PROFILES } from '../print/profiles.ts';
import { toViewportRect } from '../render/viewport.ts';
import { downloadBytes } from './download.ts';
import type { Store } from './store.ts';
import { $, el, type Ui } from './ui.ts';

const SEVERITY_LABEL: Record<Severity, string> = { error: '要修正', warn: '注意', info: '情報' };

const LAYOUT_LABEL: Record<PageLayout['kind'], string> = {
  trimbox: '仕上がり位置の指定あり(TrimBox)',
  trim: '仕上がりサイズ(塗り足しなし)',
  'trim+bleed': '塗り足し込みのサイズ',
  unknown: 'サイズ不明',
};

const METHOD_LABEL: Record<BleedMethod | 'existing', string> = {
  mirror: '端を鏡写しにして伸ばしました',
  scale: '全体を拡大しました',
  region: '白いフチを取り除いて引き伸ばしました',
  none: '塗り足しは付けていません',
  existing: '元の塗り足しを使いました',
};

// プレビューの重ね描きの色(凡例と合わせる)
const COLORS = {
  cut: 'rgba(0, 0, 0, 0.45)',
  trim: '#ff5aa8',
  bleed: '#34c6ea',
  safe: '#f2d33c',
  text: '#ffa94d',
  image: '#b197fc',
  object: '#ff8cc2',
  area: '#5fd4f0',
  /** 選んだ場所以外を暗くする色 */
  spotlight: 'rgba(16, 20, 28, 0.55)',
};

/** 選んだ場所が、ページの面積のこれ未満なら、自動で拡大して見せる */
const AUTO_ZOOM_AREA_RATIO = 0.04;
/** 拡大表示で、場所の周りに含める範囲(mm) */
const ZOOM_MIN_WIDTH_MM = 45;
const ZOOM_MIN_HEIGHT_MM = 32;

/** 指摘の場所の説明(ページと、文字の内容・線幅など) */
function markLabel(mark: Mark): string {
  return `${mark.page + 1} ページ目${mark.label ? `・${mark.label}` : ''}`;
}

const KEPT_REASON: Record<OutlineKeptReason, string> = {
  'not-embedded': 'フォントが埋め込まれていない',
  restricted: 'フォントが埋め込みを許可していない',
  unsupported: '対応していない形式のフォントの',
  type3: '図形で描かれた(Type3)フォントの',
  clip: '切り抜きに使われている',
  'glyph-missing': 'フォントの中に字形が見つからない',
  'unknown-font': 'フォントが分からない',
};

function outlineNotes(r: OutlinePageResult): string[] {
  const notes: string[] = [];
  if (r.glyphs > 0) notes.push(`文字をアウトライン化しました(${r.glyphs} 字)。`);
  if (r.removedInvisible > 0) notes.push(`検索用の見えない文字 ${r.removedInvisible} 字は削除しました。`);
  for (const k of r.kept) notes.push(`「${k.font}」は${KEPT_REASON[k.reason]}ため、文字のまま残しました${k.detail ? `(${k.detail})` : ''}。`);
  return notes;
}

function colorNotes(r: ColorPageResult, mode: ColorMode, fallback: boolean): string[] {
  const notes: string[] = [];
  if (fallback) notes.push('このページには CMYK にそのまま変換できない部分があったため、文字以外を画像にしてから変換しました。');
  if (mode === 'cmyk') {
    const parts = [r.colors > 0 ? `色の指定 ${r.colors} か所` : '', r.images > 0 ? `画像 ${r.images} 個` : '', r.shadings > 0 ? `グラデーション ${r.shadings} 個` : ''].filter(Boolean);
    notes.push(`色を CMYK(${CMYK_LUT_SOURCE})に変換しました${parts.length ? `(${parts.join('・')})` : ''}。黒やグレーの文字・線は K だけにしました。`);
    if (r.unsupported.length > 0) notes.push(`${r.unsupported.join('・')}は変換できませんでした。`);
  } else if (mode === 'k100' && r.colors > 0) {
    notes.push(`黒やグレーの文字・線など ${r.colors} か所を、K だけの色にしました。`);
  }
  if (r.richBlackText > 0) notes.push(`リッチブラックの小さな文字 ${r.richBlackText} か所を K100 にしました。`);
  if (r.whiteOverprint > 0) notes.push(`白のオーバープリント ${r.whiteOverprint} か所を解除しました。`);
  return notes;
}

interface FixedState {
  readonly analysis: PrintAnalysis;
  readonly result: FixResult;
  readonly fileName: string;
}

export function setupCheckView(store: Store, ui: Ui, goToEdit: () => void): void {
  const form = $<HTMLFormElement>('#check-form');
  const profileSelect = $<HTMLSelectElement>('#check-profile');
  const paperSelect = $<HTMLSelectElement>('#check-paper');
  const profileNote = $<HTMLElement>('#profile-note');
  const results = $<HTMLElement>('#check-results');
  const previewCanvas = $<HTMLCanvasElement>('#preview-canvas');
  const previewLabel = $<HTMLElement>('#preview-page');
  const previewPrev = $<HTMLButtonElement>('#preview-prev');
  const previewNext = $<HTMLButtonElement>('#preview-next');
  const previewPanel = $<HTMLElement>('#check-preview');
  const previewModeNote = $<HTMLElement>('#preview-mode-note');
  const focusBar = $<HTMLElement>('#preview-focus');
  const focusCount = $<HTMLElement>('#focus-count');
  const focusLabel = $<HTMLElement>('#focus-label');
  const focusZoom = $<HTMLButtonElement>('#focus-zoom');

  /** 編集中のページのチェック結果 */
  let original: PrintAnalysis | null = null;
  /** 作った入稿用 PDF とそのチェック結果(作っていなければ null) */
  let fixed: FixedState | null = null;
  /** チェックしたときの設定(入稿用 PDF の再チェックに使う) */
  let checkedOptions: CheckOptions | null = null;
  let stale = false;
  let previewPage = 0;
  let focused: Finding | null = null;
  /** 選んだ指摘の、何番目の場所を見ているか */
  let focusIndex = 0;
  let zoomed = false;
  let renderToken = 0;
  /** プレビューに描いた指摘の枠(クリックで指摘を選ぶため。キャンバスの画素) */
  let drawnMarks: { finding: Finding; index: number; x: number; y: number; w: number; h: number }[] = [];

  function clearFocus(): void {
    focused = null;
    focusIndex = 0;
    zoomed = false;
  }

  /** 指摘の場所を選んで、プレビューで強調する */
  function focusMark(f: Finding, index: number, scrollToPreview = true): void {
    const analysis = current();
    focused = f;
    focusIndex = Math.max(0, Math.min(index, f.marks.length - 1));
    const mark = f.marks[focusIndex];
    if (mark) {
      previewPage = mark.page;
      const page = analysis?.report.layouts[mark.page]?.page;
      zoomed = !!page && rectArea(mark.rect) < rectArea(page) * AUTO_ZOOM_AREA_RATIO;
    } else if (f.pages.length > 0) {
      previewPage = f.pages[0];
    }
    renderResults();
    void renderPreview();
    // 1 列の表示(狭い画面)では、プレビューが一覧の下にあるため、見える所まで動かす
    if (scrollToPreview) {
      const r = previewPanel.getBoundingClientRect();
      if (r.top > window.innerHeight || r.bottom < 0) previewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  $<HTMLButtonElement>('#focus-prev').addEventListener('click', () => focused && focusMark(focused, (focusIndex - 1 + focused.marks.length) % focused.marks.length));
  $<HTMLButtonElement>('#focus-next').addEventListener('click', () => focused && focusMark(focused, (focusIndex + 1) % focused.marks.length));
  focusZoom.addEventListener('click', () => {
    zoomed = !zoomed;
    void renderPreview();
  });
  $<HTMLButtonElement>('#focus-clear').addEventListener('click', () => {
    clearFocus();
    renderResults();
    void renderPreview();
  });
  previewCanvas.addEventListener('click', (ev) => {
    const r = previewCanvas.getBoundingClientRect();
    const ratio = previewCanvas.width / Math.max(1, r.width);
    const x = (ev.clientX - r.left) * ratio;
    const y = (ev.clientY - r.top) * ratio;
    // 小さい枠を優先する(大きな枠の中の小さな対象を選べるように)
    const hit = drawnMarks.filter((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (!hit) return;
    focusMark(hit.finding, hit.index, false);
    results.querySelector('.finding.is-focused')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  const current = (): PrintAnalysis | null => fixed?.analysis ?? original;

  // ---------- 設定 ----------

  profileSelect.replaceChildren(...PROFILES.map((p) => new Option(p.label, p.id)));
  paperSelect.replaceChildren(
    new Option('自動で判定', 'auto'),
    ...PAPER_SIZES.map((p) => new Option(`${p.label}(${formatSize(p.widthMm, p.heightMm)})`, p.id)),
  );

  function renderProfileNote(): void {
    const p = findProfile(profileSelect.value);
    const items: Node[] = [];
    items.push(
      el(
        'p',
        '',
        p.id === 'generic'
          ? `塗り足し ${p.bleedMm}mm・安全領域 ${p.safeMarginMm}mm・推奨解像度 ${p.recommendedDpi}ppi で確認します。`
          : `塗り足し ${p.bleedMm}mm・安全領域 ${p.safeMarginMm}mm・推奨解像度 ${p.recommendedDpi}ppi で確認します。公開されている入稿ガイドを元にした非公式の目安です(${p.checkedOn} 確認)。`,
      ),
    );
    if (p.sources.length > 0 || p.assumptions.length > 0) {
      const details = el('details');
      details.append(el('summary', '', '根拠と注意'));
      const list = el('ul');
      for (const a of p.assumptions) list.append(el('li', '', a));
      for (const s of p.sources) {
        const li = el('li');
        const link = el('a', '', '出典');
        link.href = s.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        li.append(`「${s.quote}」(`, link, ')');
        list.append(li);
      }
      details.append(list);
      items.push(details);
    }
    profileNote.replaceChildren(...items);
  }
  profileSelect.addEventListener('change', renderProfileNote);
  renderProfileNote();

  // ---------- チェック ----------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runCheck();
  });

  function readOptions(): CheckOptions {
    const data = new FormData(form);
    const paperId = String(data.get('paper'));
    return {
      profile: findProfile(String(data.get('profile'))),
      paper: paperId === 'auto' ? 'auto' : (findPaperSize(paperId) ?? 'auto'),
      binding: (data.get('binding') === 'saddle' ? 'saddle' : 'none') as Binding,
    };
  }

  async function discardFixed(): Promise<void> {
    await fixed?.analysis.renderDoc.loadingTask.destroy();
    fixed = null;
  }

  async function runCheck(): Promise<void> {
    if (store.pages.length === 0) {
      ui.toastReason('NO_PAGES');
      return;
    }
    const options = readOptions();
    await ui.run('PDF を作成しています…', async (progress) => {
      const bytes = await buildPdf(new SourceCache(store.sourceBytes()), store.pages);
      const next = await analyzeForPrint(bytes, options, progress);
      // 前回の結果の描画用文書を破棄する(ワーカー側のメモリを解放するため)
      await original?.renderDoc.loadingTask.destroy();
      await discardFixed();
      original = next;
      checkedOptions = options;
      stale = false;
      clearFocus();
      const firstProblem = next.report.findings.find((f) => f.severity !== 'info' && f.pages.length > 0);
      previewPage = firstProblem?.pages[0] ?? 0;
      renderResults();
      await renderPreview();
    });
  }

  // 編集画面でページが変わったら、結果が古くなったことを示す
  store.subscribe(() => {
    if (original && !stale) {
      stale = true;
      renderResults();
    }
    if (!original) renderResults();
  });

  // ---------- 入稿用 PDF を作る(M3) ----------

  async function makePrintReady(fixForm: HTMLFormElement): Promise<void> {
    if (!original || !checkedOptions) return;
    const source = original;
    const options = checkedOptions;
    const data = new FormData(fixForm);
    const marks = data.get('output') === 'marks';
    const method = (data.get('method') ?? 'none') as BleedMethod;
    const regionFit = (data.get('fit') ?? 'cover') as RegionFit;
    const targetText = String(data.get('target') ?? '').trim();
    let targetPages: ReadonlySet<number> | 'all' = 'all';
    if (targetText !== '' && targetText !== 'すべて') {
      const parsed = parsePageRanges(targetText, source.report.layouts.length);
      if (!parsed.ok) {
        ui.toastReason(parsed.code, parsed.detail);
        return;
      }
      targetPages = new Set(parsed.value.flat());
    }
    const contentBounds = new Map<number, Rect>();
    source.facts.forEach((f, i) => f.contentBounds && contentBounds.set(i, f.contentBounds));
    const flatten = data.get('flatten') === 'on';
    const flattenAll = data.get('flattenPages') === 'all';
    const flattenDpi = Number(data.get('flattenDpi') ?? 350);
    const outline = data.get('outline') === 'on';
    const colorMode = (data.get('color') ?? 'rgb') as ColorMode;
    const fixWhiteOverprint = data.get('fixWhiteOverprint') === 'on';

    await ui.run('入稿用 PDF を作っています…', async (progress) => {
      // 効果の焼き込みは、塗り足しを作る前に行う(元の大きさのページで描画する)
      let input = source.bytes;
      const flattenNotes = new Map<number, string>();
      if (flatten) {
        const pages = new Set(source.facts.flatMap((f, i) => (flattenAll || f.structure.transparency ? [i] : [])));
        if (pages.size > 0) {
          const flattened = await flattenPdf(input, pages, flattenDpi, progress);
          input = flattened.bytes;
          const lowDpiPages = new Set(
            source.report.findings
              .filter((f) => f.code === 'PRINT_IMAGE_LOW_DPI' || f.code === 'PRINT_IMAGE_BELOW_RECOMMENDED')
              .flatMap((f) => f.pages),
          );
          for (const p of flattened.pages) {
            const parts = [`効果を焼き込みました(文字以外を ${p.dpi}ppi の画像にし、文字は文字のまま上に重ねました)。`];
            if (p.invisibleText > 0) parts.push(`検索用の見えない文字 ${p.invisibleText} か所は、透明を使わない形に置き換えました。`);
            if (p.rasterizedText > 0) parts.push(`半透明などの効果が付いた文字 ${p.rasterizedText} か所は、効果ごと画像にしました。`);
            if (p.textInForms) parts.push('グループ化された部分の文字は画像になっています。');
            if (lowDpiPages.has(p.page)) parts.push('元の写真などの細かさ(解像度)は変わりません。解像度の指摘は、元の PDF の結果を参考にしてください。');
            flattenNotes.set(p.page, parts.join(''));
          }
        }
      }
      // 色の調整と文字のアウトライン化(D-035 / D-034)。色を先に調整する(リッチブラックの文字を K100 にするには、
      // 文字が文字のままである必要があるため)。CMYK にそのまま変換できない部分があるページは、
      // 焼き込み(文字以外を画像に)にしてから、変換とアウトライン化をやり直す
      const extraNotes = new Map<number, string[]>();
      const finishText = async (bytes: Uint8Array, fallbackPages: ReadonlySet<number>) => {
        let out = bytes;
        const notes = new Map<number, string[]>();
        const push = (page: number, n: string[]) => notes.set(page, [...(notes.get(page) ?? []), ...n]);
        let unsupported: number[] = [];
        if (colorMode !== 'rgb' || fixWhiteOverprint) {
          const r = await adjustColors(out, { mode: colorMode, fixWhiteOverprint, decodeJpeg: decodeJpegInBrowser }, progress);
          out = r.bytes;
          for (const pr of r.pages) push(pr.page, colorNotes(pr, colorMode, fallbackPages.has(pr.page)));
          unsupported = colorMode === 'cmyk' ? r.pages.filter((x) => x.unsupported.length > 0 && !fallbackPages.has(x.page)).map((x) => x.page) : [];
          if (unsupported.length > 0) return { out, notes, unsupported };
        }
        if (outline) {
          const r = await outlineText(out, 'all', progress);
          out = r.bytes;
          const textFindings = new Set(
            source.report.findings
              .filter((x) => ['PRINT_TEXT_OUTSIDE_TRIM', 'PRINT_TEXT_IN_UNSAFE_AREA', 'PRINT_SMALL_TEXT', 'PRINT_RICH_BLACK_TEXT'].includes(x.code))
              .flatMap((x) => x.pages),
          );
          for (const pr of r.pages) {
            push(pr.page, outlineNotes(pr));
            if (pr.glyphs > 0 && textFindings.has(pr.page)) {
              push(pr.page, ['文字を図形にしたため、文字の位置や大きさの確認は、元の PDF の結果を参考にしてください。']);
            }
          }
        }
        return { out, notes, unsupported };
      };
      let finished = await finishText(input, new Set());
      if (finished.unsupported.length > 0) {
        const fallback = new Set(finished.unsupported);
        const flattened = await flattenPdf(input, fallback, flattenDpi, progress);
        finished = await finishText(flattened.bytes, fallback);
      }
      input = finished.out;
      for (const [page, notes] of finished.notes) extraNotes.set(page, notes);

      progress('入稿用 PDF を作っています…');
      const doc = await loadPdfForEditOrThrow(input);
      const built = await buildPrintReady(doc, source.report.layouts, {
        bleedMm: options.profile.bleedMm,
        marks,
        method,
        targetPages,
        regionFit,
        contentBounds,
      });
      const result: FixResult = {
        ...built,
        pages: built.pages.map((p) => ({
          ...p,
          notes: [...(flattenNotes.has(p.page) ? [flattenNotes.get(p.page)!] : []), ...(extraNotes.get(p.page) ?? []), ...p.notes],
        })),
      };
      progress('入稿用 PDF を確認しています…');
      // TrimBox を書き込んだので、仕上がりサイズは自動判定で正しく読める
      const analysis = await analyzeForPrint(result.bytes, { ...options, paper: 'auto' }, progress);
      await discardFixed();
      const first = store.activeSources()[0];
      fixed = { analysis, result, fileName: `${first ? baseName(first.name) : 'document'}_入稿用.pdf` };
      clearFocus();
      previewPage = 0;
      renderResults();
      await renderPreview();
    });
  }

  async function addBlankPages(count: number): Promise<void> {
    if (!original || count <= 0) return;
    const last = original.report.layouts[original.report.layouts.length - 1];
    const bytes = await makeBlankPdf(count, rectWidth(last.page), rectHeight(last.page));
    // 裏表紙(最後のページ)の前に入れる
    store.insertSource('白紙', bytes, count, Math.max(0, store.pages.length - 1));
    ui.toast(`白紙を ${count} ページ、最後のページの前に入れました。`);
    await runCheck();
  }

  function renderFixPanel(analysis: PrintAnalysis): HTMLElement {
    const panel = el('section', 'fix-panel');
    panel.id = 'fix-panel';
    panel.append(el('h3', '', '入稿用 PDF を作る'));
    panel.append(el('p', 'fix-lead', '塗り足しを付け、仕上がり位置の情報(TrimBox)を書き込んだ PDF を作ります。元のファイルは変わりません。'));

    const layouts = analysis.report.layouts;
    if (layouts.some((l) => l.kind === 'unknown')) {
      panel.append(el('p', 'fix-blocked', '仕上がりサイズが分からないページがあるため作れません。左の「仕上がりサイズ」を選んで、もう一度チェックしてください。'));
      return panel;
    }

    const f = el('form', 'fix-form');
    const radio = (name: string, value: string, label: string, hint: string, checked: boolean) => {
      const row = el('label', 'fix-option');
      const input = el('input');
      input.type = 'radio';
      input.name = name;
      input.value = value;
      input.checked = checked;
      const text = el('span', 'fix-option-text');
      text.append(el('span', 'fix-option-label', label), el('span', 'fix-option-hint', hint));
      row.append(input, text);
      return row;
    };

    const output = el('fieldset', 'fix-fieldset');
    output.append(
      el('legend', '', '形式'),
      radio('output', 'bleed', '塗り足し込みのサイズ(トンボなし)', '多くの印刷所で使える形式です。', true),
      radio('output', 'marks', 'トンボ付き(日本式)', 'トンボを付けて入稿するよう指定された場合に。', false),
    );
    f.append(output);

    const noBleed = layouts.flatMap((l, i) => (l.bleedMm === 0 ? [i] : []));
    if (noBleed.length > 0) {
      const hasEdgeInk = analysis.report.findings.some((x) => x.code === 'PRINT_NO_BLEED');
      const l = layouts[noBleed[0]];
      const tw = rectWidth(l.trim);
      const th = rectHeight(l.trim);
      const b = (checkedOptions?.profile.bleedMm ?? 3) * (72 / 25.4);
      const s = Math.max((tw + 2 * b) / tw, (th + 2 * b) / th);
      const cut = ptToMm(Math.max(((s - 1) * tw) / 2, ((s - 1) * th) / 2));

      const method = el('fieldset', 'fix-fieldset');
      method.append(
        el('legend', '', `塗り足しの作り方(塗り足しのない ${noBleed.length} ページ)`),
        radio('method', 'mirror', '端を鏡写しにして伸ばす', '写真・模様・グラデーションの背景におすすめです。', hasEdgeInk),
        radio('method', 'scale', '全体を少し拡大する', `端の約 ${cut.toFixed(1)}mm が切れます。端の近くに文字がないときに。`, false),
        radio('method', 'region', '白いフチを取り除いて引き伸ばす', '余白(白いフチ)付きで作ってしまった表紙をフチなしにします。', false),
        radio('method', 'none', '塗り足しを付けない', '白いフチを残すデザインのときに。', !hasEdgeInk),
      );
      const fit = el('div', 'fix-sub');
      fit.append(
        radio('fit', 'cover', '縦横比を保つ', 'はみ出た部分は切れます。', true),
        radio('fit', 'stretch', '縦横比を変えてぴったり合わせる', '絵柄が少し伸びます。', false),
      );
      method.append(fit);
      const target = el('label', 'fix-target');
      const input = el('input', 'input-text');
      input.name = 'target';
      input.placeholder = 'すべて';
      input.setAttribute('aria-label', '塗り足しを作るページ');
      target.append(el('span', '', '対象ページ'), input, el('span', 'fix-option-hint', '表紙だけなら「1」。空欄ならすべて。'));
      method.append(target);
      f.append(method);

      const syncFit = () => {
        fit.hidden = (f.querySelector<HTMLInputElement>('input[name="method"]:checked')?.value ?? '') !== 'region';
      };
      f.addEventListener('change', syncFit);
      syncFit();
    }

    // 効果の焼き込み(透明効果などが印刷所で正しく出ない場合の対策)
    const transparentPages = analysis.facts.filter((x) => x.structure.transparency).length;
    const flattenSet = el('fieldset', 'fix-fieldset');
    flattenSet.id = 'flatten-fieldset';
    const flattenLine = el('label', 'fix-option');
    const flattenCheck = el('input');
    flattenCheck.type = 'checkbox';
    flattenCheck.name = 'flatten';
    const flattenText = el('span', 'fix-option-text');
    flattenText.append(
      el('span', 'fix-option-label', '透明効果などを焼き込む'),
      el(
        'span',
        'fix-option-hint',
        transparentPages > 0
          ? `透明効果のあるページが ${transparentPages} ページあります。印刷所で半透明・影・ぼかしなどが正しく出ないことがある場合に。文字以外を画像にし、文字は文字のまま残します。`
          : '透明効果は見つかりませんでした。必要なら「すべてのページ」を選んで焼き込めます。',
      ),
    );
    flattenLine.append(flattenCheck, flattenText);
    const flattenSub = el('div', 'fix-sub');
    flattenSub.append(
      radio('flattenPages', 'transparent', '透明効果のあるページだけ', '', transparentPages > 0),
      radio('flattenPages', 'all', 'すべてのページ', '', transparentPages === 0),
      radio('flattenDpi', '350', '350ppi(標準)', '多くの印刷所の推奨値です。', true),
      radio('flattenDpi', '600', '600ppi', '細い線や小さな文字を含む画像があるときに。ファイルが大きくなります。', false),
    );
    flattenSet.append(el('legend', '', '効果の焼き込み'), flattenLine, flattenSub);
    f.append(flattenSet);

    const checkbox = (name: string, label: string, hint: string, checked: boolean) => {
      const line = el('label', 'fix-option');
      const input = el('input');
      input.type = 'checkbox';
      input.name = name;
      input.checked = checked;
      const text = el('span', 'fix-option-text');
      text.append(el('span', 'fix-option-label', label), el('span', 'fix-option-hint', hint));
      line.append(input, text);
      return line;
    };

    // 文字のアウトライン化(D-034)
    const textSet = el('fieldset', 'fix-fieldset');
    textSet.id = 'outline-fieldset';
    textSet.append(
      el('legend', '', '文字'),
      checkbox(
        'outline',
        '文字をアウトライン化する',
        '文字を、フォントの形どおりの図形に置き換えます。印刷所のパソコンにフォントがなくても、見えているとおりに刷られます。入稿用のファイルの文字は、検索やコピーができなくなります(元のファイルは変わりません)。フォントが「埋め込み不可」としているものは、文字のまま残します。',
        false,
      ),
    );
    f.append(textSet);

    // 色(D-035)。RGB などの色を使っていなければ「すでに CMYK」と示す
    const allCmyk = analysis.facts.every((x) => x.structure.colorUse.rgb === 0 && x.structure.rgbAreas !== 'all' && x.structure.rgbAreas.length === 0);
    const colorSet = el('fieldset', 'fix-fieldset');
    colorSet.id = 'color-fieldset';
    colorSet.append(
      el('legend', '', '色'),
      radio(
        'color',
        'rgb',
        '色を変えない(元の色のまま)',
        allCmyk
          ? 'この PDF の色は、すでに CMYK です。そのまま入稿できます。'
          : 'RGB の色は RGB のまま、CMYK の色は CMYK のまま書き出します。多くの印刷所は RGB も受け付け、印刷所で CMYK に変換します。',
        true,
      ),
      radio('color', 'k100', '黒い文字と線を K100 にする(ほかの色はそのまま)', '黒やグレーの文字・線を K(黒インキ)だけの色にします。小さな文字が 4 色の版ズレでにじむのを防ぎます。', false),
      radio(
        'color',
        'cmyk',
        `CMYK に変換する(${CMYK_LUT_SOURCE})`,
        'CMYK での入稿を求められたときに。RGB などの色だけを、プレビューの「印刷の目安」と同じ基準で変換します(すでに CMYK の色はそのまま)。黒やグレーの文字・線は K だけにします。写真などは CMYK の画像になり、ファイルが大きくなることがあります。',
        false,
      ),
    );
    if (analysis.report.findings.some((x) => x.code === 'PRINT_WHITE_OVERPRINT')) {
      colorSet.append(checkbox('fixWhiteOverprint', '白のオーバープリントを解除する', '白に設定されたオーバープリントを外し、白が印刷されるようにします。', true));
    }
    f.append(colorSet);
    const syncFlatten = () => (flattenSub.hidden = !flattenCheck.checked);
    flattenCheck.addEventListener('change', syncFlatten);
    syncFlatten();

    const submit = el('button', 'btn btn-primary btn-block', '入稿用 PDF を作って確認する');
    submit.type = 'submit';
    f.append(submit);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      void makePrintReady(f);
    });
    panel.append(f);
    return panel;
  }

  function renderFixedBanner(state: FixedState): HTMLElement {
    const box = el('section', 'fixed-banner');
    box.append(el('h3', '', '入稿用 PDF を作りました'));
    box.append(el('p', '', `下の確認結果とプレビューを見て、問題がなければ保存してください。ファイル名: ${state.fileName}`));
    const notes = el('ul', 'fixed-notes');
    for (const p of state.result.pages) {
      const li = el('li');
      li.append(`${p.page + 1} ページ目: ${METHOD_LABEL[p.method]}。`, ...p.notes.map((n) => ` ${n}`));
      notes.append(li);
    }
    box.append(notes);
    const actions = el('div', 'fixed-actions');
    const save = el('button', 'btn btn-primary', '入稿用 PDF を保存');
    save.type = 'button';
    save.addEventListener('click', () => {
      downloadBytes(state.result.bytes, state.fileName, 'application/pdf');
      ui.toast(`「${state.fileName}」を保存しました。`);
    });
    const back = el('button', 'btn', '元の PDF の結果に戻る');
    back.type = 'button';
    back.addEventListener('click', async () => {
      await discardFixed();
      clearFocus();
      previewPage = 0;
      renderResults();
      await renderPreview();
    });
    actions.append(save, back);
    box.append(actions);
    return box;
  }

  // ---------- 結果 ----------

  function renderResults(): void {
    const analysis = current();
    if (store.pages.length === 0 && !analysis) {
      const empty = el('div', 'check-empty');
      empty.append(el('p', '', 'まだページがありません。'));
      const go = el('button', 'btn', '「ページの編集」で PDF を追加する');
      go.type = 'button';
      go.addEventListener('click', goToEdit);
      empty.append(go);
      results.replaceChildren(empty);
      previewPanel.hidden = true;
      return;
    }
    if (!analysis) {
      results.replaceChildren(el('p', 'check-hint', `「チェックする」を押すと、いま並んでいる ${store.pages.length} ページを確認します。`));
      previewPanel.hidden = true;
      return;
    }
    previewPanel.hidden = false;
    const { report } = analysis;
    const nodes: Node[] = [];

    if (stale) {
      const banner = el('p', 'stale-banner', 'ページが変更されました。もう一度「チェックする」を押してください。');
      banner.setAttribute('role', 'status');
      nodes.push(banner);
    }
    if (fixed) nodes.push(renderFixedBanner(fixed));

    nodes.push(renderSummary(report.layouts, report.findings));

    const list = el('ol', 'finding-list');
    for (const f of report.findings) list.append(renderFinding(f));
    if (report.findings.length > 0) nodes.push(list);

    if (!fixed && !stale) nodes.push(renderFixPanel(analysis));

    const profile = findProfile(profileSelect.value);
    const manual = el('section', 'check-section');
    manual.append(el('h3', '', `自動では確認できない項目(${profile.label})`));
    const ul = el('ul', 'manual-list');
    for (const m of profile.manualChecks) ul.append(el('li', '', m));
    manual.append(ul);
    nodes.push(manual);

    if (report.fonts.length > 0) {
      const fonts = el('section', 'check-section');
      fonts.append(el('h3', '', '使われているフォント'), el('p', 'font-list', report.fonts.join('、')));
      nodes.push(fonts);
    }

    nodes.push(
      el(
        'p',
        'check-disclaimer',
        'このチェックは目安です。入稿できることを保証するものではありません。入稿前に、印刷所の最新の入稿ガイドを確認してください。',
      ),
    );
    results.replaceChildren(...nodes);
  }

  function renderSummary(layouts: readonly PageLayout[], findings: readonly Finding[]): HTMLElement {
    const box = el('div', 'check-summary');
    const describe = (l: PageLayout) => {
      const size = l.paper
        ? `${l.paper.label}${l.landscape ? '横' : ''}(${formatSize(ptToMm(rectWidth(l.trim)), ptToMm(rectHeight(l.trim)))})`
        : formatSize(ptToMm(rectWidth(l.page)), ptToMm(rectHeight(l.page)));
      const bleed = l.bleedMm > 0 ? `・塗り足し 各辺 ${l.bleedMm.toFixed(1)}mm` : '';
      return `${size}・${LAYOUT_LABEL[l.kind]}${bleed}`;
    };
    const kinds = [...new Set(layouts.map(describe))];
    box.append(
      el(
        'p',
        'summary-layout',
        kinds.length === 1 ? `${layouts.length} ページ: ${kinds[0]}` : `${layouts.length} ページ(ページによって異なります): ${kinds.join(' / ')}`,
      ),
    );

    const counts = { error: 0, warn: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    const badges = el('div', 'summary-counts');
    for (const s of ['error', 'warn', 'info'] as const) badges.append(el('span', `count-badge sev-${s}`, `${SEVERITY_LABEL[s]} ${counts[s]}`));
    box.append(badges);
    if (counts.error === 0 && counts.warn === 0) box.append(el('p', 'summary-ok', '大きな問題は見つかりませんでした。'));
    return box;
  }

  function findingAction(f: Finding): HTMLButtonElement | null {
    if (fixed || stale) return null;
    if (f.code === 'PRINT_NO_BLEED' || f.code === 'PRINT_WHITE_EDGE') {
      const b = el('button', 'btn finding-action', '塗り足しを作る(下の「入稿用 PDF を作る」へ)');
      b.type = 'button';
      b.addEventListener('click', () => {
        const panel = document.querySelector<HTMLElement>('#fix-panel');
        panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        panel?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
      });
      return b;
    }
    if (f.code === 'PRINT_TRANSPARENCY') {
      const b = el('button', 'btn finding-action', '焼き込む(下の「入稿用 PDF を作る」へ)');
      b.type = 'button';
      b.addEventListener('click', () => {
        const set = document.querySelector<HTMLElement>('#flatten-fieldset');
        const check = set?.querySelector<HTMLInputElement>('input[name="flatten"]');
        if (check && !check.checked) check.click();
        set?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return b;
    }
    const goToOption = (label: string, selector: string, apply: (set: HTMLElement) => void) => {
      const b = el('button', 'btn finding-action', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        const set = document.querySelector<HTMLElement>(selector);
        if (!set) return;
        apply(set);
        set.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return b;
    };
    if (f.code === 'PRINT_WHITE_OVERPRINT') {
      return goToOption('解除する(下の「入稿用 PDF を作る」へ)', '#color-fieldset', (set) => {
        const c = set.querySelector<HTMLInputElement>('input[name="fixWhiteOverprint"]');
        if (c) c.checked = true;
      });
    }
    if (f.code === 'PRINT_RICH_BLACK_TEXT') {
      return goToOption('K100 にする(下の「入稿用 PDF を作る」へ)', '#color-fieldset', (set) => {
        const cmyk = set.querySelector<HTMLInputElement>('input[name="color"][value="cmyk"]');
        const r = set.querySelector<HTMLInputElement>('input[name="color"][value="k100"]');
        if (r && !cmyk?.checked) r.checked = true;
      });
    }
    if (f.code === 'PRINT_RGB_CONTENT' || f.code === 'PRINT_SPOT_COLOR') {
      return goToOption('CMYK に変換する(下の「入稿用 PDF を作る」へ)', '#color-fieldset', (set) => {
        const r = set.querySelector<HTMLInputElement>('input[name="color"][value="cmyk"]');
        if (r) r.checked = true;
      });
    }
    if (f.code === 'PRINT_PAGE_COUNT_SADDLE' && original) {
      const n = blankPagesForSaddle(original.report.layouts.length);
      const b = el('button', 'btn finding-action', `白紙を ${n} ページ足す(最後のページの前に)`);
      b.type = 'button';
      b.addEventListener('click', () => void addBlankPages(n));
      return b;
    }
    return null;
  }

  function renderFinding(f: Finding): HTMLLIElement {
    const m = PRINT_MESSAGES[f.code];
    const item = el('li', `finding sev-${f.severity}`);
    if (focused === f) item.classList.add('is-focused');
    const head = el('div', 'finding-head');
    const title = el('h3', 'finding-title', m.title);
    if (f.marks.length > 0 || f.pages.length > 0) {
      // 見出しを押しても、対象の場所を表示する
      const titleButton = el('button', 'finding-title-button');
      titleButton.type = 'button';
      titleButton.append(title);
      titleButton.addEventListener('click', () => focusMark(f, 0));
      head.append(el('span', `sev-badge sev-${f.severity}`, SEVERITY_LABEL[f.severity]), titleButton);
    } else {
      head.append(el('span', `sev-badge sev-${f.severity}`, SEVERITY_LABEL[f.severity]), title);
    }
    item.append(head, el('p', 'finding-detail', f.detail), el('p', 'finding-why', m.why));
    const fix = el('details', 'finding-fix');
    fix.append(el('summary', '', '直し方'), el('p', '', m.fix));
    item.append(fix);
    const action = findingAction(f);
    if (action) item.append(action);
    if (f.marks.length > 0) {
      // 場所の一覧: 選ぶと、プレビューでその対象だけを明るく残して示す
      const locate = el('div', 'finding-locate');
      if (focused === f) {
        const prev = el('button', 'btn btn-small', '前へ');
        prev.type = 'button';
        prev.addEventListener('click', () => focusMark(f, (focusIndex - 1 + f.marks.length) % f.marks.length));
        const next = el('button', 'btn btn-small', '次へ');
        next.type = 'button';
        next.addEventListener('click', () => focusMark(f, (focusIndex + 1) % f.marks.length));
        const mark = f.marks[focusIndex];
        locate.append(prev, el('span', 'focus-count', `${focusIndex + 1} / ${f.marks.length}`), next, el('span', 'locate-label', markLabel(mark)));
      } else {
        const show = el('button', 'btn btn-small', f.marks.length > 1 ? `場所を見る(${f.marks.length} か所)` : '場所を見る');
        show.type = 'button';
        show.addEventListener('click', () => focusMark(f, 0));
        locate.append(show);
      }
      item.append(locate);
    } else if (f.pages.length > 0) {
      const pages = el('div', 'finding-pages');
      pages.append(el('span', '', 'ページ:'));
      for (const p of f.pages.slice(0, 30)) {
        const b = el('button', 'page-chip', String(p + 1));
        b.type = 'button';
        b.setAttribute('aria-label', `${p + 1} ページ目をプレビューで表示`);
        b.addEventListener('click', () => {
          focused = f;
          previewPage = p;
          renderResults();
          void renderPreview();
        });
        pages.append(b);
      }
      item.append(pages);
    }
    item.append(el('p', 'finding-code', f.code));
    return item;
  }

  // ---------- プレビュー ----------

  previewPrev.addEventListener('click', () => {
    if (!current() || previewPage === 0) return;
    previewPage--;
    void renderPreview();
  });
  previewNext.addEventListener('click', () => {
    const analysis = current();
    if (!analysis || previewPage >= analysis.report.layouts.length - 1) return;
    previewPage++;
    void renderPreview();
  });

  type PreviewMode = 'normal' | 'gamut' | 'print';
  const MODE_NOTE: Record<PreviewMode, string> = {
    normal: '',
    gamut: `色が残っている所が、印刷でくすみやすい色です(灰色の部分は問題ありません)。判定は ${GAMUT_SOURCE}(日本の標準的なオフセット印刷)を基準にした目安です。`,
    print: '印刷したときのおおよその色です。画面の設定・印刷所・紙によって実際の色は変わります。',
  };
  const previewMode = (): PreviewMode =>
    (document.querySelector<HTMLInputElement>('input[name="preview-mode"]:checked')?.value as PreviewMode) ?? 'normal';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="preview-mode"]')) {
    radio.addEventListener('change', () => void renderPreview());
  }

  // 窓の大きさが変わったら、プレビューを描き直す(少し待ってから 1 回だけ)
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.body.dataset.mode === 'check' && current()) void renderPreview();
    }, 200);
  });

  async function renderPreview(): Promise<void> {
    const analysis = current();
    if (!analysis) return;
    const token = ++renderToken;
    const { renderDoc, report } = analysis;
    const count = report.layouts.length;
    previewPage = Math.min(previewPage, count - 1);
    previewLabel.textContent = `${previewPage + 1} / ${count} ページ${fixed ? '(入稿用 PDF)' : ''}`;
    previewPrev.disabled = previewPage === 0;
    previewNext.disabled = previewPage >= count - 1;

    const page = await renderDoc.getPage(previewPage + 1);
    const ratio = window.devicePixelRatio || 1;
    const base = page.getViewport({ scale: 1 });
    const stage = previewCanvas.parentElement!;
    const maxW = Math.max(200, stage.clientWidth - 24);
    const maxH = Math.max(240, window.innerHeight - 260);

    // 選んだ場所(このページにあるとき)
    const focusMarkHere = focused?.marks[focusIndex]?.page === previewPage ? focused.marks[focusIndex] : undefined;
    // 拡大表示: 選んだ場所の周りだけを、プレビューの枠いっぱいに描く(scale 1 の画素での範囲)
    let region = { x: 0, y: 0, w: base.width, h: base.height };
    if (zoomed && focusMarkHere) {
      const r = toViewportRect(base, focusMarkHere.rect);
      let w = Math.max(r.w * 3, mmToPt(ZOOM_MIN_WIDTH_MM));
      let h = Math.max(r.h * 3, mmToPt(ZOOM_MIN_HEIGHT_MM));
      const aspect = maxW / maxH;
      if (w / h > aspect) h = w / aspect;
      else w = h * aspect;
      w = Math.min(base.width, w);
      h = Math.min(base.height, h);
      const x = Math.min(Math.max(0, r.x + r.w / 2 - w / 2), base.width - w);
      const y = Math.min(Math.max(0, r.y + r.h / 2 - h / 2), base.height - h);
      region = { x, y, w, h };
    }
    const cssScale = Math.min(maxW / region.w, maxH / region.h);
    const viewport = page.getViewport({ scale: cssScale * ratio });
    const ox = region.x * cssScale * ratio;
    const oy = region.y * cssScale * ratio;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(region.w * cssScale * ratio);
    canvas.height = Math.round(region.h * cssScale * ratio);
    await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -ox, -oy] }).promise;
    if (token !== renderToken) return; // 描画中に別のページが選ばれた

    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const mode = previewMode();
    if (mode !== 'normal') {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // RGB で描いた所だけを変える(CMYK の色は、印刷される色の指定そのもの)
      const areas = analysis.facts[previewPage]?.structure.rgbAreas ?? 'all';
      const mask =
        areas === 'all'
          ? undefined
          : maskFromRects(
              canvas.width,
              canvas.height,
              areas.map((r) => {
                const v = toViewportRect(viewport, r);
                return { x0: v.x - ox, y0: v.y - oy, x1: v.x - ox + v.w, y1: v.y - oy + v.h };
              }),
            );
      const converted = mode === 'gamut' ? highlightOutOfGamut(image.data, mask) : simulatePrint(image.data, mask);
      ctx.putImageData(new ImageData(converted, image.width, image.height), 0, 0);
    }
    previewModeNote.textContent = MODE_NOTE[mode];
    previewModeNote.hidden = mode === 'normal';
    const layout = report.layouts[previewPage];
    // 重ね描きは、拡大表示の範囲の分だけずらす
    const toPx = (r: Rect) => {
      const v = toViewportRect(viewport, r);
      return { x: v.x - ox, y: v.y - oy, w: v.w, h: v.h };
    };
    const page_ = toPx(layout.page);
    const trim = toPx(layout.trim);
    const bleed = toPx(layout.bleed);
    const safe = toPx(layout.safe);

    // 断裁で落ちる部分(仕上がり線の外)を暗くする
    ctx.save();
    ctx.fillStyle = COLORS.cut;
    ctx.beginPath();
    ctx.rect(page_.x, page_.y, page_.w, page_.h);
    ctx.rect(trim.x, trim.y, trim.w, trim.h);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.lineWidth = 1.5 * ratio;
    if (bleed.w < page_.w - 1 || bleed.h < page_.h - 1) {
      ctx.setLineDash([4 * ratio, 3 * ratio]);
      ctx.strokeStyle = COLORS.bleed;
      ctx.strokeRect(bleed.x, bleed.y, bleed.w, bleed.h);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = COLORS.trim;
    ctx.strokeRect(trim.x, trim.y, trim.w, trim.h);
    ctx.setLineDash([6 * ratio, 4 * ratio]);
    ctx.strokeStyle = COLORS.safe;
    ctx.strokeRect(safe.x, safe.y, safe.w, safe.h);
    ctx.setLineDash([]);

    // 指摘の枠: 指摘を選んでいれば、その指摘の枠だけを描く。選んでいなければ、「情報」以外の指摘の枠を描く
    const pad = 2 * ratio;
    drawnMarks = [];
    const shown = focused ? [focused] : report.findings.filter((f) => f.severity !== 'info');
    for (const f of shown) {
      f.marks.forEach((mark, index) => {
        if (mark.page !== previewPage || mark === focusMarkHere) return;
        const r = toPx(mark.rect);
        ctx.lineWidth = 1.5 * ratio;
        ctx.strokeStyle = COLORS[mark.kind];
        ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
        drawnMarks.push({ finding: f, index, x: r.x - pad * 2, y: r.y - pad * 2, w: r.w + pad * 4, h: r.h + pad * 4 });
      });
    }
    if (focusMarkHere && focused) {
      // 選んだ場所だけを明るく残し、それ以外を暗くする(スポットライト)
      const r = toPx(focusMarkHere.rect);
      const hole = { x: r.x - pad * 3, y: r.y - pad * 3, w: r.w + pad * 6, h: r.h + pad * 6 };
      ctx.save();
      ctx.fillStyle = COLORS.spotlight;
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(hole.x, hole.y, hole.w, hole.h);
      ctx.fill('evenodd');
      ctx.lineWidth = 3 * ratio;
      ctx.strokeStyle = COLORS[focusMarkHere.kind];
      ctx.strokeRect(hole.x, hole.y, hole.w, hole.h);
      // 場所の説明を、枠の上(入らなければ下)に添える
      const text = markLabel(focusMarkHere);
      ctx.font = `${12 * ratio}px system-ui, sans-serif`;
      const tw = ctx.measureText(text).width + 12 * ratio;
      const th = 20 * ratio;
      const tx = Math.min(Math.max(0, hole.x), Math.max(0, canvas.width - tw));
      const ty = hole.y - th - 4 * ratio >= 0 ? hole.y - th - 4 * ratio : Math.min(canvas.height - th, hole.y + hole.h + 4 * ratio);
      ctx.fillStyle = COLORS[focusMarkHere.kind];
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, tx + 6 * ratio, ty + th / 2);
      ctx.restore();
      drawnMarks.push({ finding: focused, index: focusIndex, x: hole.x, y: hole.y, w: hole.w, h: hole.h });
    }
    previewCanvas.classList.toggle('has-marks', drawnMarks.length > 0);

    // 選んだ指摘の場所の操作
    focusBar.hidden = !focused || focused.marks.length === 0;
    if (focused && focused.marks.length > 0) {
      focusCount.textContent = `${focusIndex + 1} / ${focused.marks.length}`;
      focusLabel.textContent = `${PRINT_MESSAGES[focused.code].title}: ${markLabel(focused.marks[focusIndex])}`;
      focusZoom.disabled = !focusMarkHere;
      focusZoom.setAttribute('aria-pressed', String(zoomed && !!focusMarkHere));
      focusZoom.textContent = zoomed && focusMarkHere ? 'ページ全体を見る' : '拡大して見る';
    }

    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    previewCanvas.style.width = `${Math.round(canvas.width / ratio)}px`;
    previewCanvas.style.height = `${Math.round(canvas.height / ratio)}px`;
    previewCanvas.getContext('2d')!.drawImage(canvas, 0, 0);
    previewCanvas.setAttribute(
      'aria-label',
      `${previewPage + 1} ページ目のプレビュー。赤い線が仕上がり線、緑の点線が安全領域、暗い部分は断裁で切り落とされる部分です。`,
    );
    page.cleanup();
  }

  renderResults();
}
