// 「ページの中」タブ(M6): ページ内の要素をレイヤーとして一覧し、移動・拡大縮小・削除する。
// 変更はタブの中の作業用のコピーに対して行い、「適用」で編集画面の並び(元のファイルの新しい版)に反映する。
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist';
import { normalizeRotation, type PageRef } from '../core/pageList.ts';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { applyElementEdits, pageTransform, type ElementEdit } from '../editor/edit.ts';
import { elementLabel, extractElements, type PageElement } from '../editor/elements.ts';
import { mmToPt, rectHeight, rectWidth, transformRect, type Rect } from '../print/geometry.ts';
import { pageContentBytes } from '../print/structure.ts';
import { openForRender } from '../render/pdfjs.ts';
import { toViewportRect } from '../render/viewport.ts';
import type { Store } from './store.ts';
import { $, el, type Ui } from './ui.ts';

type TransformEdit = Extract<ElementEdit, { kind: 'transform' }>;

interface Session {
  readonly ref: PageRef;
  /** 1 ページだけの作業用の PDF(元のまま) */
  readonly base: Uint8Array;
  readonly content: Uint8Array;
  readonly elements: PageElement[];
}

const KIND_LABEL: Record<PageElement['kind'], string> = {
  image: '画像',
  text: '文字',
  path: '図形',
  shading: 'グラデーション',
  group: 'グループ',
  mixed: 'まとまり',
};

const NUDGE_MM = 0.5;
const NUDGE_FAST_MM = 5;

export interface EditorView {
  /** タブを開いたとき */
  show(): void;
  /** 適用していない変更があるか */
  hasUnapplied(): boolean;
  discard(): void;
}

export function setupEditorView(store: Store, ui: Ui): EditorView {
  const pageSelect = $<HTMLSelectElement>('#editor-page');
  const stage = $<HTMLElement>('#editor-stage');
  const canvas = $<HTMLCanvasElement>('#editor-canvas');
  const overlay = $<HTMLCanvasElement>('#editor-overlay');
  const layerList = $<HTMLOListElement>('#editor-layer-list');
  const props = $<HTMLElement>('#editor-props');
  const status = $<HTMLElement>('#editor-status');
  const empty = $<HTMLElement>('#editor-empty');
  const showHidden = $<HTMLInputElement>('#editor-show-hidden');
  const applyButton = $<HTMLButtonElement>('#editor-apply');
  const discardButton = $<HTMLButtonElement>('#editor-discard');
  const undoButton = $<HTMLButtonElement>('#editor-undo');
  const redoButton = $<HTMLButtonElement>('#editor-redo');

  let session: Session | null = null;
  let pageIndexInList = 0;
  let edits = new Map<number, ElementEdit>();
  let past: Map<number, ElementEdit>[] = [];
  let future: Map<number, ElementEdit>[] = [];
  /** プレビューでだけ隠す要素(保存には影響しない) */
  const hidden = new Set<number>();
  let selected: number | null = null;
  let moveEffects = true;
  let viewport: PageViewport | null = null;
  let renderDoc: PDFDocumentProxy | null = null;
  let renderToken = 0;
  const ratio = () => window.devicePixelRatio || 1;

  // ---------- ページの選択 ----------

  function refreshPageOptions(): void {
    pageSelect.replaceChildren(
      ...store.pages.map((p, i) => {
        const s = store.sources.get(p.sourceId);
        return new Option(`${i + 1} ページ目(${s?.name ?? ''} p.${p.pageIndex + 1})`, String(i));
      }),
    );
    pageSelect.value = String(Math.min(pageIndexInList, Math.max(0, store.pages.length - 1)));
  }

  async function openPage(index: number): Promise<void> {
    const ref = store.pages[index];
    if (!ref) {
      session = null;
      renderAll();
      return;
    }
    pageIndexInList = index;
    await ui.run('ページを読み込んでいます…', async () => {
      const src = await loadPdfForEditOrThrow(store.sources.get(ref.sourceId)!.bytes);
      const tmp = await PDFDocument.create({ updateMetadata: false });
      const [copy] = await tmp.copyPages(src, [ref.pageIndex]);
      tmp.addPage(copy);
      const base = await tmp.save();
      const work = await loadPdfForEditOrThrow(base);
      session = { ref, base, content: pageContentBytes(work, work.getPage(0)), elements: extractElements(work, work.getPage(0)) };
      edits = new Map();
      past = [];
      future = [];
      hidden.clear();
      selected = null;
      renderAll();
      await renderPreview();
    });
  }

  function confirmDiscard(): boolean {
    return !hasUnapplied() || window.confirm('適用していない変更があります。破棄してよいですか?');
  }

  pageSelect.addEventListener('change', () => {
    if (!confirmDiscard()) {
      pageSelect.value = String(pageIndexInList);
      return;
    }
    void openPage(Number(pageSelect.value));
  });
  $<HTMLButtonElement>('#editor-prev').addEventListener('click', () => {
    if (pageIndexInList > 0 && confirmDiscard()) void openPage(pageIndexInList - 1);
  });
  $<HTMLButtonElement>('#editor-next').addEventListener('click', () => {
    if (pageIndexInList < store.pages.length - 1 && confirmDiscard()) void openPage(pageIndexInList + 1);
  });

  // ---------- 編集の状態 ----------

  function hasUnapplied(): boolean {
    return edits.size > 0;
  }

  function commit(next: Map<number, ElementEdit>): void {
    past.push(edits);
    future = [];
    edits = next;
    renderAll();
    void renderPreview();
  }

  /** 選んだ要素と、一緒に動かす要素(効果・見えない文字) */
  function companions(id: number): number[] {
    if (!session) return [id];
    return [
      id,
      ...session.elements
        .filter((e) => e.overlayOf === id || (moveEffects && e.effectOf === id))
        .map((e) => e.id),
    ];
  }

  function transformOf(id: number): TransformEdit | undefined {
    const e = edits.get(id);
    return e?.kind === 'transform' ? e : undefined;
  }

  function editTransform(id: number, change: (t: TransformEdit) => TransformEdit): void {
    if (!session) return;
    const main = session.elements[id];
    if (!main.movable) {
      ui.toast('この要素は、ほかの要素と一体になっているため動かせません(削除はできます)。', 'error', 'EDIT_NOT_MOVABLE');
      return;
    }
    const current = transformOf(id) ?? {
      kind: 'transform',
      dx: 0,
      dy: 0,
      scale: 1,
      anchor: [(main.bounds.x0 + main.bounds.x1) / 2, (main.bounds.y0 + main.bounds.y1) / 2],
    };
    const next = change(current);
    const map = new Map(edits);
    for (const cid of companions(id)) {
      if (session.elements[cid].movable) map.set(cid, { ...next, anchor: current.anchor });
    }
    commit(map);
  }

  function deleteSelected(): void {
    if (selected === null || !session) return;
    const map = new Map(edits);
    for (const cid of companions(selected)) map.set(cid, { kind: 'delete' });
    // 削除した要素の効果も消す
    for (const e of session.elements) if (e.effectOf === selected) map.set(e.id, { kind: 'delete' });
    commit(map);
  }

  /** 表示上の範囲(編集を反映したもの) */
  function displayedBounds(e: PageElement): Rect {
    const t = transformOf(e.id);
    return t ? transformRect(pageTransform(t), e.bounds) : e.bounds;
  }

  // ---------- 描画 ----------

  async function renderPreview(): Promise<void> {
    if (!session) return;
    const token = ++renderToken;
    const work = await loadPdfForEditOrThrow(session.base);
    const page = work.getPage(0);
    const previewEdits = new Map(edits);
    for (const id of hidden) previewEdits.set(id, { kind: 'delete' });
    page.node.set(PDFName.of('Contents'), work.context.register(work.context.flateStream(applyElementEdits(session.content, session.elements, previewEdits))));
    const doc = await openForRender(await work.save());
    if (token !== renderToken) {
      await doc.loadingTask.destroy();
      return;
    }
    await renderDoc?.loadingTask.destroy();
    renderDoc = doc;
    const pdfPage = await doc.getPage(1);
    const rotation = normalizeRotation(pdfPage.rotate + session.ref.rotation);
    const base = pdfPage.getViewport({ scale: 1, rotation });
    const maxW = Math.max(240, stage.clientWidth - 32);
    const maxH = Math.max(320, window.innerHeight - 200);
    const scale = Math.min(maxW / base.width, maxH / base.height) * ratio();
    const vp = pdfPage.getViewport({ scale, rotation });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    await pdfPage.render({ canvas: off, viewport: vp }).promise;
    if (token !== renderToken) return;
    for (const c of [canvas, overlay]) {
      c.width = off.width;
      c.height = off.height;
      c.style.width = `${Math.round(off.width / ratio())}px`;
      c.style.height = `${Math.round(off.height / ratio())}px`;
    }
    canvas.getContext('2d')!.drawImage(off, 0, 0);
    viewport = vp;
    drawOverlay();
  }

  function drawOverlay(ghost?: { dx: number; dy: number }): void {
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!session || !viewport || selected === null) return;
    const r = ratio();
    const sel = session.elements[selected];
    const box = (e: PageElement, color: string, dash: number[]) => {
      const v = toViewportRect(viewport!, displayedBounds(e));
      ctx.setLineDash(dash.map((d) => d * r));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * r;
      ctx.strokeRect(v.x + (ghost?.dx ?? 0), v.y + (ghost?.dy ?? 0), v.w, v.h);
    };
    for (const e of session.elements) if (e.effectOf === selected) box(e, '#7c4dff', [5, 3]);
    box(sel, sel.movable ? '#1f5fbf' : '#b3261e', []);
    ctx.setLineDash([]);
  }

  function renderAll(): void {
    const hasPages = store.pages.length > 0;
    empty.hidden = hasPages && !!session;
    stage.hidden = !session;
    undoButton.disabled = past.length === 0;
    redoButton.disabled = future.length === 0;
    applyButton.disabled = edits.size === 0;
    discardButton.disabled = edits.size === 0;
    status.textContent = edits.size > 0 ? `適用していない変更: ${edits.size} 個の要素` : '';
    renderLayers();
    renderProps();
    drawOverlay();
  }

  function chip(text: string, cls = ''): HTMLElement {
    return el('span', `layer-chip ${cls}`, text);
  }

  function renderLayers(): void {
    if (!session) {
      layerList.replaceChildren();
      return;
    }
    const els = session.elements;
    const showInvisible = showHidden.checked;
    const row = (e: PageElement, nested: boolean): HTMLLIElement => {
      const li = el('li', `layer-row${nested ? ' is-nested' : ''}${e.id === selected ? ' is-selected' : ''}`);
      li.dataset.id = String(e.id);
      const eye = el('button', 'layer-eye', hidden.has(e.id) ? '○' : '●');
      eye.type = 'button';
      eye.title = hidden.has(e.id) ? 'プレビューで表示する' : 'プレビューで一時的に隠す(保存には影響しません)';
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (hidden.has(e.id)) hidden.delete(e.id);
        else hidden.add(e.id);
        renderAll();
        void renderPreview();
      });
      const label = el('span', 'layer-label');
      const icon = el('span', 'layer-icon');
      icon.dataset.kind = e.kind;
      icon.title = KIND_LABEL[e.kind];
      label.append(icon, el('span', 'layer-name', nested && e.overlayOf !== undefined ? `検索用の見えない文字「${(e.events[0].text ?? '').slice(0, 10)}」` : elementLabel(e, els)));
      const chips = el('span', 'layer-chips');
      if (e.effectOf !== undefined) chips.append(chip('効果(推定)', 'is-effect'));
      if (e.transparent && e.effectOf === undefined) chips.append(chip('半透明'));
      if (!e.movable) chips.append(chip('固定', 'is-fixed'));
      const edit = edits.get(e.id);
      if (edit?.kind === 'delete') chips.append(chip('削除', 'is-deleted'));
      else if (edit) chips.append(chip('変更', 'is-changed'));
      li.append(eye, label, chips);
      li.addEventListener('click', () => select(e.id));
      return li;
    };
    const nodes: HTMLLIElement[] = [];
    // 上が手前: 描画の順番の逆。効果と見えない文字は、関連する要素の下に字下げして並べる
    for (const e of [...els].reverse()) {
      if (e.effectOf !== undefined || e.overlayOf !== undefined) continue;
      if (e.invisible && !showInvisible) continue;
      nodes.push(row(e, false));
      for (const child of els.filter((x) => x.effectOf === e.id)) nodes.push(row(child, true));
      if (showInvisible) for (const child of els.filter((x) => x.overlayOf === e.id)) nodes.push(row(child, true));
    }
    layerList.replaceChildren(...nodes);
    layerList.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  function numberInput(name: string, value: number, step: number, label: string): HTMLLabelElement {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', label));
    const input = el('input', 'input-num');
    input.type = 'number';
    input.name = name;
    input.step = String(step);
    input.value = value.toFixed(1);
    wrap.append(input);
    return wrap;
  }

  function renderProps(): void {
    if (!session || selected === null || !viewport) {
      props.replaceChildren(el('p', 'hint', 'ページの上の要素か、下のレイヤーを選ぶと、ここに詳しい情報が出ます。ドラッグや矢印キーで動かせます。'));
      return;
    }
    const e = session.elements[selected];
    const v = toViewportRect(viewport, displayedBounds(e));
    const pxPerMm = viewport.scale * (72 / 25.4);
    const box = el('div', 'props-box');
    box.append(el('h3', 'props-title', elementLabel(e, session.elements)));
    const info: string[] = [];
    const p = e.events.find((x) => x.pixels)?.pixels;
    if (p && p.width > 4) info.push(`${p.width}×${p.height}px・約 ${Math.round(p.dpi / (transformOf(e.id)?.scale ?? 1))}ppi`);
    const font = e.events.find((x) => x.fontName)?.fontName;
    if (font) info.push(`フォント: ${font}`);
    const effects = session.elements.filter((x) => x.effectOf === e.id).length;
    const overlays = session.elements.filter((x) => x.overlayOf === e.id).length;
    if (effects) info.push(`効果(推定): ${effects} 個`);
    if (overlays) info.push(`検索用の見えない文字: ${overlays} 個(一緒に動きます)`);
    if (info.length) box.append(el('p', 'props-info', info.join(' / ')));
    if (!e.movable) box.append(el('p', 'props-warn', 'この要素は、ほかの要素と一体になっているため動かせません(削除はできます)。'));

    const form = el('form', 'props-form');
    const row1 = el('div', 'field-row');
    row1.append(
      numberInput('x', v.x / pxPerMm, 0.5, '左から(mm)'),
      numberInput('y', v.y / pxPerMm, 0.5, '上から(mm)'),
      numberInput('scale', (transformOf(e.id)?.scale ?? 1) * 100, 5, '大きさ(%)'),
    );
    form.append(row1, el('p', 'hint', `大きさ: ${(v.w / pxPerMm).toFixed(1)} × ${(v.h / pxPerMm).toFixed(1)}mm`));
    for (const input of form.querySelectorAll('input')) input.disabled = !e.movable;
    form.addEventListener('change', () => {
      const data = new FormData(form);
      const x = Number(data.get('x'));
      const y = Number(data.get('y'));
      const s = Number(data.get('scale')) / 100;
      if (![x, y, s].every(Number.isFinite) || s <= 0) return;
      // 位置: 画面上の移動量を、ページ座標の移動量に直す(ページの回転を考慮)
      const [ax, ay] = viewport!.convertToPdfPoint(v.x, v.y) as [number, number];
      const [bx, by] = viewport!.convertToPdfPoint(x * pxPerMm, y * pxPerMm) as [number, number];
      editTransform(e.id, (t) => ({ ...t, dx: t.dx + (bx - ax), dy: t.dy + (by - ay), scale: s }));
    });
    box.append(form);

    if (effects) {
      const line = el('label', 'checkbox-line');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = moveEffects;
      check.addEventListener('change', () => (moveEffects = check.checked));
      line.append(check, ' 効果も一緒に動かす');
      box.append(line);
    }
    const actions = el('div', 'props-actions');
    const del = el('button', 'btn btn-danger', '削除');
    del.type = 'button';
    del.addEventListener('click', deleteSelected);
    const reset = el('button', 'btn', 'この要素の変更を戻す');
    reset.type = 'button';
    reset.disabled = !edits.has(e.id);
    reset.addEventListener('click', () => {
      const map = new Map(edits);
      for (const cid of companions(e.id)) map.delete(cid);
      for (const x of session!.elements) if (x.effectOf === e.id) map.delete(x.id);
      commit(map);
    });
    actions.append(del, reset);
    box.append(actions);
    props.replaceChildren(box);
  }

  function select(id: number | null): void {
    if (!session) return;
    // 効果を選んだら、本体を選ぶ(本体と一緒に扱う)
    selected = id !== null && session.elements[id].effectOf !== undefined ? session.elements[id].effectOf! : id;
    renderAll();
  }

  // ---------- ページの上での操作 ----------

  function pdfPointAt(ev: MouseEvent): [number, number] {
    const r = overlay.getBoundingClientRect();
    return viewport!.convertToPdfPoint((ev.clientX - r.left) * ratio(), (ev.clientY - r.top) * ratio()) as [number, number];
  }

  function hitTest(x: number, y: number): number | null {
    if (!session) return null;
    const inside = (e: PageElement) => {
      const b = displayedBounds(e);
      return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
    };
    const candidates = session.elements.filter((e) => !hidden.has(e.id) && !e.invisible && edits.get(e.id)?.kind !== 'delete' && inside(e));
    // 手前(後に描かれたもの)を優先し、そのなかで小さいもの(背景より中身)を選ぶ
    candidates.sort((a, b) => b.id - a.id);
    const top = candidates.slice(0, 4).sort((a, b) => rectWidth(a.bounds) * rectHeight(a.bounds) - rectWidth(b.bounds) * rectHeight(b.bounds));
    return top[0]?.id ?? null;
  }

  let drag: { startX: number; startY: number; pdf: [number, number]; id: number } | null = null;

  overlay.addEventListener('mousedown', (ev) => {
    if (!session || !viewport) return;
    const [x, y] = pdfPointAt(ev);
    const hit = hitTest(x, y);
    if (hit === null) {
      select(null);
      return;
    }
    const target = session.elements[hit].effectOf ?? hit;
    if (target !== selected) select(target);
    if (session.elements[target].movable) drag = { startX: ev.clientX, startY: ev.clientY, pdf: [x, y], id: target };
    stage.focus();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    drawOverlay({ dx: (ev.clientX - drag.startX) * ratio(), dy: (ev.clientY - drag.startY) * ratio() });
  });
  window.addEventListener('mouseup', (ev) => {
    if (!drag || !viewport) return;
    const d = drag;
    drag = null;
    if (Math.abs(ev.clientX - d.startX) < 2 && Math.abs(ev.clientY - d.startY) < 2) {
      drawOverlay();
      return;
    }
    const [x, y] = pdfPointAt(ev);
    editTransform(d.id, (t) => ({ ...t, dx: t.dx + (x - d.pdf[0]), dy: t.dy + (y - d.pdf[1]) }));
  });

  stage.addEventListener('keydown', (ev) => {
    if (!session || selected === null || !viewport) return;
    const step = mmToPt(ev.shiftKey ? NUDGE_FAST_MM : NUDGE_MM);
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (ev.key in arrows) {
      ev.preventDefault();
      const [sx, sy] = arrows[ev.key];
      // 画面上の向きでずらす(ページの回転を考慮して、ページ座標の移動量に直す)
      const pxPerPt = viewport.scale;
      const [ax, ay] = viewport.convertToPdfPoint(0, 0) as [number, number];
      const [bx, by] = viewport.convertToPdfPoint(sx * step * pxPerPt, sy * step * pxPerPt) as [number, number];
      editTransform(selected, (t) => ({ ...t, dx: t.dx + (bx - ax), dy: t.dy + (by - ay) }));
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      deleteSelected();
    } else if (ev.key === 'Escape') {
      select(null);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (document.body.dataset.mode !== 'editor' || !(ev.ctrlKey || ev.metaKey)) return;
    if ((ev.target as Element).closest('input, textarea, select, dialog')) return;
    if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undoButton.click();
    } else if (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey)) {
      ev.preventDefault();
      redoButton.click();
    }
  });

  // ---------- ボタン ----------

  undoButton.addEventListener('click', () => {
    const prev = past.pop();
    if (!prev) return;
    future.push(edits);
    edits = prev;
    renderAll();
    void renderPreview();
  });
  redoButton.addEventListener('click', () => {
    const next = future.pop();
    if (!next) return;
    past.push(edits);
    edits = next;
    renderAll();
    void renderPreview();
  });
  discardButton.addEventListener('click', () => discard());
  showHidden.addEventListener('change', renderLayers);

  applyButton.addEventListener('click', () => {
    if (!session || edits.size === 0) return;
    const s = session;
    void ui.run('ページに反映しています…', async () => {
      const doc = await loadPdfForEditOrThrow(store.sources.get(s.ref.sourceId)!.bytes);
      const page = doc.getPage(s.ref.pageIndex);
      const next = applyElementEdits(pageContentBytes(doc, page), s.elements, edits);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
      const count = edits.size;
      edits = new Map();
      store.replaceSources(new Map([[s.ref.sourceId, await doc.save({ useObjectStreams: true })]]));
      ui.toast(`${count} 個の要素の変更を、ページに反映しました。編集画面の「元に戻す」で取り消せます。`);
    });
    // replaceSources で並びが変わる → store の通知で、同じ位置のページを開き直す
  });

  function discard(): void {
    edits = new Map();
    past = [];
    future = [];
    renderAll();
    void renderPreview();
  }

  // 編集画面でページが変わったら、ページの一覧を更新し、開いているページを開き直す
  let pendingReload = false;
  store.subscribe(() => {
    refreshPageOptions();
    if (document.body.dataset.mode === 'editor') void reloadCurrent();
    else pendingReload = true;
  });

  async function reloadCurrent(): Promise<void> {
    pendingReload = false;
    const ref = store.pages[pageIndexInList];
    if (!ref) {
      session = null;
      renderAll();
      return;
    }
    if (session && ref.key === session.ref.key && ref.rotation === session.ref.rotation) return;
    await openPage(pageIndexInList);
  }

  return {
    show() {
      refreshPageOptions();
      if (!session || pendingReload) void reloadCurrent();
      else void renderPreview();
      renderAll();
    },
    hasUnapplied,
    discard,
  };
}
