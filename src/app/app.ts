// 画面の組み立てと操作。PDF の処理そのものは src/core/ の純粋関数に任せる。
import { baseName, buildPdf, SourceCache, zipFiles, type NamedFile } from '../core/build.ts';
import {
  keysBetween,
  movePages,
  nudgePages,
  pickPages,
  removePages,
  removeSource,
  rotatePages,
  type PageRef,
} from '../core/pageList.ts';
import { loadPdfForEdit } from '../core/pdfLoad.ts';
import { groupLabel, planSplit, type SplitPlan } from '../core/ranges.ts';
import { REASONS } from '../core/reasons.ts';
import { setupCheckView } from './checkView.ts';
import { downloadBytes } from './download.ts';
import { Store } from './store.ts';
import { Thumbnails } from './thumbnails.ts';
import { setupPwa } from './pwa.ts';
import { setupTypoDialog } from './typoDialog.ts';
import { $, createUi, el } from './ui.ts';

const PAGE_DRAG_TYPE = 'application/x-pdf-page-keys';

export type Mode = 'edit' | 'check';

export function startApp(): void {
  const store = new Store();
  const thumbs = new Thumbnails(store);
  const { toast, toastReason, run } = createUi();

  const grid = $<HTMLOListElement>('#grid');
  const filesBar = $<HTMLElement>('#files');
  const fileInput = $<HTMLInputElement>('#file-input');
  const selectionCount = $<HTMLElement>('#selection-count');
  const dropOverlay = $<HTMLElement>('#drop-overlay');
  const splitDialog = $<HTMLDialogElement>('#split-dialog');
  const splitForm = $<HTMLFormElement>('#split-form');
  const splitError = $<HTMLElement>('#split-error');
  const privacyDialog = $<HTMLDialogElement>('#privacy-dialog');

  const cards = new Map<string, HTMLLIElement>();

  // ---------- 描画 ----------

  function render(): void {
    const { pages, selection } = store;
    document.body.classList.toggle('has-pages', pages.length > 0);

    const nodes = pages.map((page, index) => {
      let card = cards.get(page.key);
      if (!card) {
        card = createCard(page);
        cards.set(page.key, card);
      }
      updateCard(card, page, index, selection.has(page.key));
      return card;
    });
    grid.replaceChildren(...nodes);

    renderFiles();

    const hasPages = pages.length > 0;
    const hasSelection = selection.size > 0;
    selectionCount.textContent = hasPages
      ? hasSelection
        ? `${selection.size} / ${pages.length} ページを選択中`
        : `全 ${pages.length} ページ`
      : '';
    setEnabled('select-all', hasPages);
    setEnabled('select-none', hasSelection);
    for (const action of ['rotate-left', 'rotate-right', 'move-prev', 'move-next', 'delete', 'save-selected']) {
      setEnabled(action, hasSelection);
    }
    setEnabled('undo', store.canUndo);
    setEnabled('redo', store.canRedo);
    setEnabled('save-all', hasPages);
    setEnabled('open-split', hasPages);
    setEnabled('open-typo', hasPages);
  }

  function setEnabled(action: string, enabled: boolean): void {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (button) button.disabled = !enabled;
  }

  function createCard(page: PageRef): HTMLLIElement {
    const source = store.sources.get(page.sourceId)!;
    const card = el('li', 'page-card');
    card.dataset.key = page.key;
    card.dataset.color = String(source.colorIndex);
    card.draggable = true;

    const thumb = el('div', 'thumb');
    const canvas = el('canvas');
    thumb.append(canvas, el('span', 'thumb-error', 'プレビューできません'));

    const check = el('input', 'card-check');
    check.type = 'checkbox';

    const meta = el('div', 'card-meta');
    meta.append(el('span', 'card-num'), el('span', 'card-src', `${source.name} · p.${page.pageIndex + 1}`));
    meta.title = `${source.name} の ${page.pageIndex + 1} ページ目`;

    card.append(thumb, check, meta);
    thumbs.observe(card, canvas, page.sourceId, page.pageIndex);
    return card;
  }

  function updateCard(card: HTMLLIElement, page: PageRef, index: number, selected: boolean): void {
    card.dataset.rotation = String(page.rotation);
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-selected', String(selected));
    const check = card.querySelector<HTMLInputElement>('.card-check')!;
    check.checked = selected;
    check.setAttribute('aria-label', `${index + 1} ページ目を選択`);
    card.querySelector('.card-num')!.textContent = String(index + 1);
  }

  function renderFiles(): void {
    const counts = new Map<string, number>();
    for (const p of store.pages) counts.set(p.sourceId, (counts.get(p.sourceId) ?? 0) + 1);
    filesBar.replaceChildren(
      ...store.activeSources().map((source) => {
        const chip = el('span', 'file-chip');
        chip.dataset.color = String(source.colorIndex);
        const used = counts.get(source.id) ?? 0;
        const remove = el('button', 'file-remove', '×');
        remove.type = 'button';
        remove.dataset.removeSource = source.id;
        remove.setAttribute('aria-label', `${source.name} を取り除く`);
        remove.title = 'このファイルのページをすべて取り除く';
        chip.append(
          el('span', 'file-dot'),
          el('span', 'file-name', source.name),
          el('span', 'file-count', used === source.pageCount ? `${used} ページ` : `${used} / ${source.pageCount} ページ`),
          remove,
        );
        return chip;
      }),
    );
  }

  // ---------- 画面の切り替え ----------

  function setMode(mode: Mode): void {
    document.body.dataset.mode = mode;
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')) {
      const selected = tab.dataset.modeTab === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    $<HTMLElement>('#edit-view').hidden = mode !== 'edit';
    $<HTMLElement>('#check-view').hidden = mode !== 'check';
  }

  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')) {
    tab.addEventListener('click', () => setMode(tab.dataset.modeTab as Mode));
  }

  // ---------- ファイルの追加 ----------

  async function addFiles(files: readonly File[]): Promise<void> {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const skipped = files.length - pdfs.length;
    if (skipped > 0) toast(`PDF 以外のファイル ${skipped} 件は読み込みませんでした。`);
    if (pdfs.length === 0) return;

    await run('読み込んでいます…', async (progress) => {
      for (const [i, file] of pdfs.entries()) {
        if (pdfs.length > 1) progress(`読み込んでいます…(${i + 1} / ${pdfs.length})`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await loadPdfForEdit(bytes);
        if (!result.ok) {
          toastReason(result.code, file.name);
          continue;
        }
        store.addSource(file.name, bytes, result.value.getPageCount());
      }
    });
  }

  // ---------- 保存 ----------

  function outputBase(): string {
    const first = store.activeSources()[0];
    return first ? baseName(first.name) : 'document';
  }

  async function saveAll(): Promise<void> {
    const sources = store.activeSources();
    const name = sources.length > 1 ? `${outputBase()}_結合.pdf` : `${outputBase()}_編集済み.pdf`;
    await run('PDF を作成しています…', async () => {
      const bytes = await buildPdf(new SourceCache(store.sourceBytes()), store.pages);
      downloadBytes(bytes, name, 'application/pdf');
      toast(`「${name}」を保存しました。`);
    });
  }

  async function saveSelected(): Promise<void> {
    const pages = pickPages(store.pages, store.selection);
    if (pages.length === 0) return toastReason('NOTHING_SELECTED');
    const name = `${outputBase()}_抜き出し.pdf`;
    await run('PDF を作成しています…', async () => {
      const bytes = await buildPdf(new SourceCache(store.sourceBytes()), pages);
      downloadBytes(bytes, name, 'application/pdf');
      toast(`「${name}」(${pages.length} ページ)を保存しました。`);
    });
  }

  function readSplitPlan(): SplitPlan {
    const data = new FormData(splitForm);
    const mode = data.get('mode');
    if (mode === 'every') return { mode: 'every', size: Number(data.get('size')) };
    if (mode === 'ranges') return { mode: 'ranges', input: String(data.get('ranges') ?? '') };
    return { mode: 'each' };
  }

  async function saveSplit(groups: number[][]): Promise<void> {
    const base = outputBase();
    const pages = store.pages;
    await run('分割しています…', async (progress) => {
      const cache = new SourceCache(store.sourceBytes());
      const files: NamedFile[] = [];
      for (const [i, group] of groups.entries()) {
        progress(`分割しています…(${i + 1} / ${groups.length})`);
        const bytes = await buildPdf(cache, group.map((index) => pages[index]));
        files.push({ name: `${base}_${groupLabel(group)}.pdf`, bytes });
      }
      if (files.length === 1) {
        downloadBytes(files[0].bytes, files[0].name, 'application/pdf');
        toast(`「${files[0].name}」を保存しました。`);
      } else {
        const zipName = `${base}_分割.zip`;
        downloadBytes(zipFiles(files), zipName, 'application/zip');
        toast(`${files.length} 個の PDF を「${zipName}」にまとめて保存しました。`);
      }
    });
  }

  // ---------- 操作 ----------

  const actions: Record<string, () => void> = {
    'select-all': () => store.select(store.pages.map((p) => p.key)),
    'select-none': () => store.select([], null),
    'rotate-left': () => store.commit(rotatePages(store.pages, store.selection, -90)),
    'rotate-right': () => store.commit(rotatePages(store.pages, store.selection, 90)),
    'move-prev': () => store.commit(nudgePages(store.pages, store.selection, -1)),
    'move-next': () => store.commit(nudgePages(store.pages, store.selection, 1)),
    delete: () => store.commit(removePages(store.pages, store.selection)),
    undo: () => store.undo(),
    redo: () => store.redo(),
    'save-all': () => void saveAll(),
    'save-selected': () => void saveSelected(),
    'open-split': () => {
      splitError.textContent = '';
      splitDialog.showModal();
    },
  };

  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const button = target.closest<HTMLButtonElement>('[data-action]');
    if (button && !button.disabled) {
      actions[button.dataset.action!]?.();
      return;
    }
    const remove = target.closest<HTMLButtonElement>('[data-remove-source]');
    if (remove) store.commit(removeSource(store.pages, remove.dataset.removeSource!));
    if (target.closest('[data-close]')) target.closest('dialog')?.close();
  });

  // カードのクリック: 単独選択 / Ctrl で追加・解除 / Shift で範囲選択 / チェックボックスで追加・解除
  grid.addEventListener('click', (e) => {
    const target = e.target as Element;
    const card = target.closest<HTMLLIElement>('.page-card');
    if (!card) return;
    const key = card.dataset.key!;
    const toggle = target.classList.contains('card-check') || e.ctrlKey || e.metaKey;
    if (e.shiftKey && store.anchor) {
      const range = keysBetween(store.pages, store.anchor, key);
      store.select(toggle ? [...store.selection, ...range] : range, store.anchor);
    } else if (toggle) {
      const next = new Set(store.selection);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      store.select(next, key);
    } else {
      store.select([key], key);
    }
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target as Element;
    if (target.closest('input[type="text"], input[type="number"], textarea, select, dialog')) return;
    // 入稿チェック画面では、ページを消すなどの編集ショートカットを無効にする
    if (document.body.dataset.mode !== 'edit') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a' && store.pages.length > 0) {
      e.preventDefault();
      actions['select-all']();
    } else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      store.redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection.size > 0) {
      e.preventDefault();
      actions.delete();
    } else if (e.key === 'Escape' && store.selection.size > 0) {
      actions['select-none']();
    }
  });

  // ---------- ドラッグによる並べ替え ----------

  let draggingPages = false;
  let dropIndex = -1;

  function dropIndexAt(x: number, y: number): number {
    const list = [...grid.children] as HTMLElement[];
    for (const [i, item] of list.entries()) {
      const r = item.getBoundingClientRect();
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return list.length;
  }

  function showDropMarker(index: number): void {
    if (index === dropIndex) return;
    clearDropMarker();
    dropIndex = index;
    const list = grid.children;
    if (index < list.length) list[index].classList.add('drop-before');
    else list[list.length - 1]?.classList.add('drop-after');
  }

  function clearDropMarker(): void {
    dropIndex = -1;
    grid.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  grid.addEventListener('dragstart', (e) => {
    const card = (e.target as Element).closest<HTMLLIElement>('.page-card');
    if (!card || !e.dataTransfer) return;
    const key = card.dataset.key!;
    if (!store.selection.has(key)) store.select([key], key);
    draggingPages = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(PAGE_DRAG_TYPE, [...store.selection].join('\n'));
    grid.classList.add('is-dragging');
  });

  grid.addEventListener('dragover', (e) => {
    if (!draggingPages) return;
    e.preventDefault();
    showDropMarker(dropIndexAt(e.clientX, e.clientY));
  });

  grid.addEventListener('drop', (e) => {
    if (!draggingPages) return;
    e.preventDefault();
    const index = dropIndexAt(e.clientX, e.clientY);
    clearDropMarker();
    store.commit(movePages(store.pages, store.selection, index));
  });

  grid.addEventListener('dragend', () => {
    draggingPages = false;
    clearDropMarker();
    grid.classList.remove('is-dragging');
  });

  // ---------- ファイルのドロップ ----------

  const hasFiles = (e: DragEvent) => !draggingPages && (e.dataTransfer?.types.includes('Files') ?? false);
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  });

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void addFiles(files);
  });

  // ---------- ダイアログ ----------

  splitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const plan = planSplit(readSplitPlan(), store.pages.length);
    if (!plan.ok) {
      splitError.textContent = `${REASONS[plan.code].message}${plan.detail ? `(${plan.detail})` : ''}`;
      return;
    }
    splitDialog.close();
    void saveSplit(plan.value);
  });

  // 入力欄を触ったら、対応するラジオボタンを選ぶ
  splitForm.addEventListener('focusin', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name === 'size' || input.name === 'ranges') {
      const radio = splitForm.querySelector<HTMLInputElement>(`input[name="mode"][value="${input.name === 'size' ? 'every' : 'ranges'}"]`);
      if (radio) radio.checked = true;
    }
  });

  $<HTMLButtonElement>('#privacy-open').addEventListener('click', () => privacyDialog.showModal());

  setupCheckView(store, { toast, toastReason, run }, () => setMode('edit'));
  setupTypoDialog(store, { toast, toastReason, run });
  setupPwa({ toast, toastReason, run }, addFiles);

  store.subscribe(render);
  setMode('edit');
  render();
}
