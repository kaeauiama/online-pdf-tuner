// 誤植を直す(S1・試験的)のダイアログ。
import type { PDFDocument } from '@cantoo/pdf-lib';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { ReasonError } from '../core/reasons.ts';
import type { SourceId } from '../core/pageList.ts';
import { findPcFonts, normalizeFontName, supportsPcFonts, type LocalFont } from '../typo/localFonts.ts';
import { applyTypos, findTypos, TYPO_MESSAGES, type LocalFontLookup, type TypoMatch } from '../typo/typo.ts';
import type { Store } from './store.ts';
import { $, el, type Ui } from './ui.ts';

interface FoundMatch {
  readonly sourceId: SourceId;
  /** 並びの中での位置(1 始まり。表示用) */
  readonly displayPage: number;
  readonly match: TypoMatch;
}

export function setupTypoDialog(store: Store, ui: Ui): void {
  const dialog = $<HTMLDialogElement>('#typo-dialog');
  const form = $<HTMLFormElement>('#typo-form');
  const errorBox = $<HTMLElement>('#typo-error');
  const resultsBox = $<HTMLElement>('#typo-results');
  const applyButton = $<HTMLButtonElement>('#typo-apply');

  let found: FoundMatch[] = [];
  let replaceText = '';
  /** 利用者が許可して読み込んだ PC のフォント(キーは normalizeFontName した名前) */
  let pcFonts: Map<string, LocalFont> | null = null;
  const lookup = (): LocalFontLookup | undefined => (pcFonts ? (name) => pcFonts!.get(normalizeFontName(name)) : undefined);

  $<HTMLButtonElement>('[data-action="open-typo"]').addEventListener('click', () => {
    errorBox.textContent = '';
    resultsBox.replaceChildren();
    found = [];
    applyButton.disabled = true;
    dialog.showModal();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void search();
  });

  async function search(): Promise<void> {
    const data = new FormData(form);
    const find = String(data.get('find') ?? '');
    const replace = String(data.get('replace') ?? '');
    errorBox.textContent = '';
    if (find === '' || replace === '') {
      errorBox.textContent = '直したい文字と、正しい文字を入れてください。';
      return;
    }
    if (Array.from(find).length !== Array.from(replace).length) {
      errorBox.textContent = `字数が違います(${Array.from(find).length} 字 → ${Array.from(replace).length} 字)。この機能では、同じ字数の置き換えだけができます。`;
      return;
    }
    if (find === replace) {
      errorBox.textContent = '直したい文字と正しい文字が同じです。';
      return;
    }
    const selectedOnly = data.get('selectedOnly') === 'on';
    const pages = store.pages.filter((p) => !selectedOnly || store.selection.has(p.key));
    if (pages.length === 0) {
      errorBox.textContent = selectedOnly ? 'ページが選択されていません。' : 'ページがありません。';
      return;
    }

    await ui.run('文字を探しています…', async () => {
      const position = new Map(store.pages.map((p, i) => [`${p.sourceId}:${p.pageIndex}`, i + 1]));
      const bySource = new Map<SourceId, number[]>();
      for (const p of pages) bySource.set(p.sourceId, [...(bySource.get(p.sourceId) ?? []), p.pageIndex]);
      const next: FoundMatch[] = [];
      for (const [sourceId, pageIndexes] of bySource) {
        const doc = await loadPdfForEditOrThrow(store.sources.get(sourceId)!.bytes);
        for (const match of findTypos(doc, pageIndexes, find, replace, lookup())) {
          next.push({ sourceId, displayPage: position.get(`${sourceId}:${match.pageIndex}`) ?? 0, match });
        }
      }
      next.sort((a, b) => a.displayPage - b.displayPage);
      found = next;
      replaceText = replace;
      renderResults(find, replace);
    });
  }

  function renderResults(find: string, replace: string): void {
    if (found.length === 0) {
      resultsBox.replaceChildren(
        el('p', 'typo-empty', `「${find}」は見つかりませんでした。`),
        el('p', 'typo-hint', '文字が画像になっている場合や、文字の途中で記録が分かれている場合は見つかりません。'),
      );
      applyButton.disabled = true;
      return;
    }
    const fixable = found.filter((f) => f.match.fixable).length;
    const list = el('ul', 'typo-list');
    found.forEach((f, i) => {
      const item = el('li', `typo-item ${f.match.fixable ? 'is-ok' : 'is-ng'}`);
      const line = el('label', 'typo-line');
      const check = el('input');
      check.type = 'checkbox';
      check.dataset.index = String(i);
      check.checked = f.match.fixable;
      check.disabled = !f.match.fixable;
      const text = el('span', 'typo-text');
      const b = f.match.before;
      const a = f.match.after;
      text.append(
        el('span', 'typo-page', `${f.displayPage} ページ目`),
        `…${b}`,
        el('mark', 'typo-old', find),
        `${a}…`,
        f.match.fixable ? ' → ' : '',
      );
      if (f.match.fixable) text.append(`…${b}`, el('mark', 'typo-new', replace), `${a}…`);
      if (f.match.fixable && f.match.localKey) text.append(el('span', 'typo-local-tag', 'PC のフォントで補う'));
      line.append(check, text);
      item.append(line);
      if (!f.match.fixable && f.match.reason) item.append(el('p', 'typo-reason', TYPO_MESSAGES[f.match.reason](f.match)));
      list.append(item);
    });
    const summary = el(
      'p',
      'typo-summary',
      `${found.length} 箇所見つかりました。そのうち ${fixable} 箇所を置き換えられます。${fixable < found.length ? '置き換えられない箇所は、理由を表示しています。' : ''}`,
    );
    const nodes: Node[] = [summary, list];

    // 埋め込みのフォントに字が足りない箇所があれば、PC の同じフォントで補う案内を出す(D-027。Chrome / Edge のみ)
    const missingFonts = [...new Set(found.filter((f) => f.match.reason === 'TYPO_GLYPH_MISSING' || f.match.reason === 'TYPO_FONT_LICENSE_UNKNOWN').map((f) => f.match.fontName))];
    if (missingFonts.length > 0 && !pcFonts) {
      const box = el('div', 'typo-pc-fonts');
      if (supportsPcFonts()) {
        const button = el('button', 'btn', 'PC のフォントで補って探し直す');
        button.type = 'button';
        button.addEventListener('click', () => void usePcFonts(missingFonts, find, replace));
        box.append(
          el('p', 'typo-hint', `この PC に「${missingFonts.join('」「')}」が入っていれば、足りない字をそこから補えます(フォントの許諾も、PC のフォントで確認します)。初めて使うときは、ブラウザがフォントへのアクセスの許可を求めます(フォントはこの PC の中で読むだけで、送信しません)。`),
          button,
        );
      } else {
        box.append(el('p', 'typo-hint', 'PC のフォントで足りない字を補う機能は、Chrome または Edge でだけ使えます。'));
      }
      nodes.push(box);
    }
    resultsBox.replaceChildren(...nodes);
    applyButton.disabled = fixable === 0;
    applyButton.textContent = `選んだ箇所を置き換える`;
  }

  async function usePcFonts(fontNames: string[], find: string, replace: string): Promise<void> {
    // 許可ダイアログはボタンを押した直後でないと出ないため、ほかの処理より先に呼ぶ
    let fonts: Map<string, LocalFont>;
    try {
      fonts = await findPcFonts(fontNames);
    } catch (e) {
      if (e instanceof ReasonError) ui.toastReason(e.code, e.detail);
      else throw e;
      return;
    }
    pcFonts = fonts;
    form.querySelector<HTMLInputElement>('input[name="find"]')!.value = find;
    form.querySelector<HTMLInputElement>('input[name="replace"]')!.value = replace;
    await search();
  }

  applyButton.addEventListener('click', () => void apply());

  async function apply(): Promise<void> {
    const chosen = [...resultsBox.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')]
      .map((c) => found[Number(c.dataset.index)])
      .filter((f) => f?.match.fixable);
    if (chosen.length === 0) return;
    await ui.run('置き換えています…', async () => {
      const bySource = new Map<SourceId, TypoMatch[]>();
      for (const f of chosen) bySource.set(f.sourceId, [...(bySource.get(f.sourceId) ?? []), f.match]);
      const replacements = new Map<SourceId, Uint8Array>();
      let count = 0;
      for (const [sourceId, matches] of bySource) {
        const doc: PDFDocument = await loadPdfForEditOrThrow(store.sources.get(sourceId)!.bytes);
        count += await applyTypos(doc, matches, lookup());
        replacements.set(sourceId, await doc.save({ useObjectStreams: true }));
      }
      store.replaceSources(replacements);
      dialog.close();
      ui.toast(`${count} 箇所を「${replaceText}」に置き換えました。元に戻すには Ctrl+Z を押してください。`);
    });
  }
}
