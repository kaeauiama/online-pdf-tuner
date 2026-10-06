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
import { imagesToPdf } from '../core/images.ts';
import { decodeImage, isImageFile, setupImageExport, setupImageImport } from './imageDialogs.ts';
import { setupEditorView } from './editorView.ts';
import { setupPwa } from './pwa.ts';
import { setupWriteDialogs } from './writeDialogs.ts';
import { setupTypoDialog } from './typoDialog.ts';
import { $, createUi, el } from './ui.ts';

const PAGE_DRAG_TYPE = 'application/x-pdf-page-keys';

export type Mode = 'edit' | 'editor' | 'check';

export function startApp(): void {
  const store = new Store();
  const thumbs = new Thumbnails(store);
  const ui = createUi();
  const { toast, toastReason, run } = ui;
  const chooseImageOptions = setupImageImport();
  const editor = setupEditorView(store, ui);

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
    $<HTMLElement>('#page-total').textContent = hasPages ? `/ ${pages.length}` : '';
    $<HTMLInputElement>('#page-jump').max = String(pages.length);
    for (const action of ['rotate-left', 'rotate-right', 'move-prev', 'move-next', 'delete', 'save-selected']) {
      setEnabled(action, hasSelection);
    }
    setEnabled('undo', store.canUndo);
    setEnabled('redo', store.canRedo);
    setEnabled('save-all', hasPages);
    setEnabled('open-split', hasPages);
    setEnabled('open-typo', hasPages);
    setEnabled('open-numbers', hasPages);
    setEnabled('open-text', hasPages);
    setEnabled('open-export-images', hasPages);
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

    const open = el('button', 'card-open');
    open.type = 'button';
    open.title = '「ページの中」で開く(ダブルクリックでも開けます)';
    open.setAttribute('aria-label', '「ページの中」で開く');
    open.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>';

    const meta = el('div', 'card-meta');
    meta.append(el('span', 'card-num'), el('span', 'card-src', `${source.name} · p.${page.pageIndex + 1}`));
    meta.title = `${source.name} の ${page.pageIndex + 1} ページ目`;

    card.append(thumb, check, open, meta);
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

  /** 画面を切り替える。page: 「ページの中」で開くページ(編集画面の並びでの位置) */
  async function setMode(mode: Mode, page?: number): Promise<void> {
    const current = document.body.dataset.mode as Mode | undefined;
    // 「ページの中」で適用していない変更があれば、離れる前に「適用 / 破棄 / 残る」を選んでもらう
    if (current === 'editor' && mode !== 'editor' && !(await editor.confirmLeave())) return;
    // 「ページの中」から編集画面に戻ったら、開いていたページを選んで見せる
    const editedPage = current === 'editor' && mode === 'edit' ? editor.currentPage() : undefined;
    document.body.dataset.mode = mode;
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')) {
      const selected = tab.dataset.modeTab === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    $<HTMLElement>('#edit-view').hidden = mode !== 'edit';
    $<HTMLElement>('#editor-view').hidden = mode !== 'editor';
    $<HTMLElement>('#check-view').hidden = mode !== 'check';
    if (mode === 'editor') editor.show(page);
    measure();
    if (editedPage !== undefined && store.pages[editedPage]) locatePage(editedPage);
  }

  /** 一覧のページを選び、見える位置まで動かして一瞬強調する */
  function locatePage(index: number): void {
    const ref = store.pages[index];
    if (!ref) return;
    store.select([ref.key], ref.key);
    const card = cards.get(ref.key);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.classList.remove('is-located');
    void card.offsetWidth; // アニメーションをやり直す
    card.classList.add('is-located');
  }

  function openInEditor(key: string): void {
    const index = store.pages.findIndex((p) => p.key === key);
    if (index >= 0) void setMode('editor', index);
  }

  // 固定したヘッダーとツールバーの高さを、CSS から使えるようにする(sticky の位置・スクロールの余白)
  const header = $<HTMLElement>('.app-header');
  const toolbar = $<HTMLElement>('#edit-view .toolbar');
  const measure = () => {
    const root = document.documentElement.style;
    const fixed = getComputedStyle(header).position === 'sticky';
    root.setProperty('--header-h', `${fixed ? header.offsetHeight : 0}px`);
    root.setProperty('--toolbar-h', `${document.body.dataset.mode === 'edit' ? toolbar.offsetHeight : 0}px`);
  };
  new ResizeObserver(measure).observe(header);
  new ResizeObserver(measure).observe(toolbar);

  // 一覧の表示: ページへ移動・サムネイルの大きさ(大きさは、この PC のブラウザに覚えておく)
  const jump = $<HTMLInputElement>('#page-jump');
  jump.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const n = Math.round(Number(jump.value));
    if (!Number.isFinite(n) || n < 1 || n > store.pages.length) {
      toast(`1〜${store.pages.length} の番号を入れてください。`, 'error');
      return;
    }
    locatePage(n - 1);
  });
  const SIZE_KEY = 'pdf-workbench:thumb-size';
  const applySize = (size: string) => {
    grid.dataset.size = size;
    const radio = document.querySelector<HTMLInputElement>(`input[name="thumb-size"][value="${size}"]`);
    if (radio) radio.checked = true;
  };
  try {
    applySize(localStorage.getItem(SIZE_KEY) === 'small' ? 'small' : 'normal');
  } catch {
    applySize('normal');
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="thumb-size"]')) {
    radio.addEventListener('change', () => {
      applySize(radio.value);
      try {
        localStorage.setItem(SIZE_KEY, radio.value);
      } catch {
        // 保存できなくても、表示は切り替わる
      }
    });
  }

  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-mode-tab]')) {
    tab.addEventListener('click', () => void setMode(tab.dataset.modeTab as Mode));
  }

  // ---------- ファイルの追加 ----------

  async function addFiles(files: readonly File[]): Promise<void> {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const images = files.filter((f) => !pdfs.includes(f) && isImageFile(f));
    const skipped = files.length - pdfs.length - images.length;
    if (skipped > 0) toast(`PDF・画像以外のファイル ${skipped} 件は読み込みませんでした。`);

    if (images.length > 0) {
      const options = await chooseImageOptions(images.length);
      if (options) {
        await run('画像を PDF にしています…', async () => {
          const decoded = [];
          for (const file of images) {
            try {
              decoded.push(await decodeImage(file));
            } catch {
              toast(`「${file.name}」は画像として読み込めませんでした。`, 'error');
            }
          }
          if (decoded.length === 0) return;
          const bytes = await imagesToPdf(decoded, options);
          const first = images[0].name.replace(/\.[^.]+$/, '');
          store.addSource(images.length > 1 ? `${first} ほか${images.length - 1}枚.pdf` : `${first}.pdf`, bytes, decoded.length);
        });
      }
    }
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
    if (target.closest('.card-open')) {
      openInEditor(key);
      return;
    }
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

  // カードのダブルクリック: そのページを「ページの中」で開く
  grid.addEventListener('dblclick', (e) => {
    const card = (e.target as Element).closest<HTMLLIElement>('.page-card');
    if (!card || (e.target as Element).closest('.card-check, .card-open')) return;
    openInEditor(card.dataset.key!);
  });

  // Alt+1〜3: 画面の切り替え(どの画面からでも)
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    const mode = ({ '1': 'edit', '2': 'editor', '3': 'check' } as const)[e.key as '1' | '2' | '3'];
    if (!mode) return;
    e.preventDefault();
    void setMode(mode);
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
    } else if (e.key === 'Enter' && !mod && store.selection.size === 1 && !target.closest('button, a, input')) {
      // 1 ページだけ選んでいるとき: そのページを「ページの中」で開く
      e.preventDefault();
      openInEditor([...store.selection][0]);
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

  setupCheckView(store, ui, () => void setMode('edit'));
  setupTypoDialog(store, ui);
  setupWriteDialogs(store, ui);
  setupImageExport(store, ui);
  setupPwa(ui, addFiles);

  store.subscribe(render);
  void setMode('edit');
  render();
}
