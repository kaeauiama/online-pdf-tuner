// 入稿チェック画面。編集中のページを PDF に書き出して解析し、指摘とプレビューを表示する。
import { buildPdf, SourceCache } from '../core/build.ts';
import { analyzeForPrint, type PrintAnalysis } from '../print/analyze.ts';
import type { Binding, Finding, Mark, Severity } from '../print/checks.ts';
import { highlightOutOfGamut, simulatePrint } from '../print/gamut.ts';
import { ptToMm, rectHeight, rectWidth, type Rect } from '../print/geometry.ts';
import type { PageLayout } from '../print/layout.ts';
import { PRINT_MESSAGES } from '../print/messages.ts';
import { findPaperSize, formatSize, PAPER_SIZES } from '../print/paperSizes.ts';
import { findProfile, PROFILES } from '../print/profiles.ts';
import { toViewportRect } from '../render/viewport.ts';
import type { Store } from './store.ts';
import { $, el, type Ui } from './ui.ts';

const SEVERITY_LABEL: Record<Severity, string> = { error: '要修正', warn: '注意', info: '情報' };

const LAYOUT_LABEL: Record<PageLayout['kind'], string> = {
  trimbox: '仕上がり位置の指定あり(TrimBox)',
  trim: '仕上がりサイズ(塗り足しなし)',
  'trim+bleed': '塗り足し込みのサイズ',
  unknown: 'サイズ不明',
};

// プレビューの重ね描きの色(凡例と合わせる)
const COLORS = {
  cut: 'rgba(20, 24, 32, 0.38)',
  trim: '#e0245e',
  safe: '#1e9e5a',
  text: '#f08c00',
  image: '#7c4dff',
};

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

  let analysis: PrintAnalysis | null = null;
  let stale = false;
  let previewPage = 0;
  let focused: Finding | null = null;
  let renderToken = 0;

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

  // ---------- 実行 ----------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void runCheck();
  });

  async function runCheck(): Promise<void> {
    if (store.pages.length === 0) {
      ui.toastReason('NO_PAGES');
      return;
    }
    const data = new FormData(form);
    const profile = findProfile(String(data.get('profile')));
    const paperId = String(data.get('paper'));
    const paper = paperId === 'auto' ? 'auto' : (findPaperSize(paperId) ?? 'auto');
    const binding = (data.get('binding') === 'saddle' ? 'saddle' : 'none') as Binding;
    await ui.run('PDF を作成しています…', async (progress) => {
      const bytes = await buildPdf(new SourceCache(store.sourceBytes()), store.pages);
      const next = await analyzeForPrint(bytes, { profile, paper, binding }, progress);
      // 前回の結果の描画用文書を破棄する(ワーカー側のメモリを解放するため)
      await analysis?.renderDoc.loadingTask.destroy();
      analysis = next;
      stale = false;
      focused = null;
      const firstProblem = next.report.findings.find((f) => f.severity !== 'info' && f.pages.length > 0);
      previewPage = firstProblem?.pages[0] ?? 0;
      renderResults();
      await renderPreview();
    });
  }

  // 編集画面でページが変わったら、結果が古くなったことを示す
  store.subscribe(() => {
    if (analysis && !stale) {
      stale = true;
      renderResults();
    }
    if (!analysis) renderResults();
  });

  // ---------- 結果 ----------

  function renderResults(): void {
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

    nodes.push(renderSummary(report.layouts, report.findings));

    const list = el('ol', 'finding-list');
    for (const f of report.findings) list.append(renderFinding(f));
    if (report.findings.length > 0) nodes.push(list);

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
      const size = l.paper ? `${l.paper.label}${l.landscape ? '横' : ''}(${formatSize(ptToMm(rectWidth(l.trim)), ptToMm(rectHeight(l.trim)))})` : formatSize(ptToMm(rectWidth(l.page)), ptToMm(rectHeight(l.page)));
      const bleed = l.bleedMm > 0 ? `・塗り足し 各辺 ${l.bleedMm.toFixed(1)}mm` : '';
      return `${size}・${LAYOUT_LABEL[l.kind]}${bleed}`;
    };
    const kinds = [...new Set(layouts.map(describe))];
    box.append(el('p', 'summary-layout', kinds.length === 1 ? `${layouts.length} ページ: ${kinds[0]}` : `${layouts.length} ページ(ページによって異なります): ${kinds.join(' / ')}`));

    const counts = { error: 0, warn: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;
    const badges = el('div', 'summary-counts');
    for (const s of ['error', 'warn', 'info'] as const) {
      const b = el('span', `count-badge sev-${s}`, `${SEVERITY_LABEL[s]} ${counts[s]}`);
      badges.append(b);
    }
    box.append(badges);
    if (counts.error === 0 && counts.warn === 0) {
      box.append(el('p', 'summary-ok', '大きな問題は見つかりませんでした。'));
    }
    return box;
  }

  function renderFinding(f: Finding): HTMLLIElement {
    const m = PRINT_MESSAGES[f.code];
    const item = el('li', `finding sev-${f.severity}`);
    if (focused === f) item.classList.add('is-focused');
    const head = el('div', 'finding-head');
    head.append(el('span', `sev-badge sev-${f.severity}`, SEVERITY_LABEL[f.severity]), el('h3', 'finding-title', m.title));
    item.append(head, el('p', 'finding-detail', f.detail), el('p', 'finding-why', m.why));
    const fix = el('details', 'finding-fix');
    fix.append(el('summary', '', '直し方'), el('p', '', m.fix));
    item.append(fix);
    if (f.pages.length > 0) {
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
    if (!analysis || previewPage === 0) return;
    previewPage--;
    void renderPreview();
  });
  previewNext.addEventListener('click', () => {
    if (!analysis || previewPage >= analysis.report.layouts.length - 1) return;
    previewPage++;
    void renderPreview();
  });

  type PreviewMode = 'normal' | 'gamut' | 'print';
  const MODE_NOTE: Record<PreviewMode, string> = {
    normal: '',
    gamut: '色が残っている所が、印刷でくすみやすい色です(灰色の部分は問題ありません)。判定は一般的なオフセット印刷を基準にした目安です。',
    print: '印刷したときのおおよその色です。画面の設定・印刷所・紙によって実際の色は変わります。',
  };
  const previewMode = (): PreviewMode =>
    (document.querySelector<HTMLInputElement>('input[name="preview-mode"]:checked')?.value as PreviewMode) ?? 'normal';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="preview-mode"]')) {
    radio.addEventListener('change', () => void renderPreview());
  }

  async function renderPreview(): Promise<void> {
    if (!analysis) return;
    const token = ++renderToken;
    const { renderDoc, report } = analysis;
    const count = report.layouts.length;
    previewLabel.textContent = `${previewPage + 1} / ${count} ページ`;
    previewPrev.disabled = previewPage === 0;
    previewNext.disabled = previewPage >= count - 1;

    const page = await renderDoc.getPage(previewPage + 1);
    const ratio = window.devicePixelRatio || 1;
    const base = page.getViewport({ scale: 1 });
    const stage = previewCanvas.parentElement!;
    const maxW = Math.max(200, stage.clientWidth - 24);
    const maxH = Math.max(240, window.innerHeight - 260);
    const cssScale = Math.min(maxW / base.width, maxH / base.height);
    const viewport = page.getViewport({ scale: cssScale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    if (token !== renderToken) return; // 描画中に別のページが選ばれた

    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const mode = previewMode();
    if (mode !== 'normal') {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const converted = mode === 'gamut' ? highlightOutOfGamut(image.data) : simulatePrint(image.data);
      ctx.putImageData(new ImageData(converted, image.width, image.height), 0, 0);
    }
    previewModeNote.textContent = MODE_NOTE[mode];
    previewModeNote.hidden = mode === 'normal';
    const layout = report.layouts[previewPage];
    const toPx = (r: Rect) => toViewportRect(viewport, r);
    const page_ = toPx(layout.page);
    const trim = toPx(layout.trim);
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
    ctx.strokeStyle = COLORS.trim;
    ctx.strokeRect(trim.x, trim.y, trim.w, trim.h);
    ctx.setLineDash([6 * ratio, 4 * ratio]);
    ctx.strokeStyle = COLORS.safe;
    ctx.strokeRect(safe.x, safe.y, safe.w, safe.h);
    ctx.setLineDash([]);

    // 「情報」の指摘の枠は、その指摘を選んだときだけ描く(常に描くとプレビューが見づらくなるため)
    const marks: Mark[] = report.findings
      .filter((f) => f.severity !== 'info' || f === focused)
      .flatMap((f) => f.marks.filter((m) => m.page === previewPage));
    const focusedMarks = new Set(focused?.marks ?? []);
    for (const mark of marks) {
      const r = toPx(mark.rect);
      const pad = 2 * ratio;
      ctx.lineWidth = (focusedMarks.has(mark) ? 3 : 1.5) * ratio;
      ctx.strokeStyle = mark.kind === 'text' ? COLORS.text : COLORS.image;
      ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
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
