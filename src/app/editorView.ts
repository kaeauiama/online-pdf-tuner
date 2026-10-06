// 「ページの中」タブ(M6): ページ内の要素をレイヤーとして一覧し、移動・拡大縮小・削除・重なり順の変更・文字の書き換えをする。
// 変更はタブの中の作業用のコピーに対して行い、「適用」で編集画面の並び(元のファイルの新しい版)に反映する。
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist';
import { normalizeRotation, type PageRef } from '../core/pageList.ts';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { applyElementEdits, pageTransform, type ElementEdit } from '../editor/edit.ts';
import { elementLabel, extractElements, type PageElement } from '../editor/elements.ts';
import { analyzeLayering, moveInOrder, orderLimits, type Layering, type OrderMove } from '../editor/order.ts';
import { planTextEdit, TEXT_EDIT_MESSAGES, textEditSplices, textLines, textPlanWarnings, type TextLine, type TextPlan } from '../editor/textEdit.ts';
import { lexContent } from '../pdf/lexer.ts';
import { mmToPt, rect, rectHeight, rectWidth, transformRect, unionRect, type Rect } from '../print/geometry.ts';
import { pageContentBytes } from '../print/structure.ts';
import { openForRender } from '../render/pdfjs.ts';
import { toViewportRect } from '../render/viewport.ts';
import { findPcFonts, normalizeFontName, supportsPcFonts, type LocalFont } from '../typo/localFonts.ts';
import type { LocalFontLookup } from '../typo/typo.ts';
import type { Store } from './store.ts';
import { $, el, type Ui } from './ui.ts';

type TransformEdit = Extract<ElementEdit, { kind: 'transform' }>;

interface Session {
  readonly ref: PageRef;
  /** 1 ページだけの作業用の PDF(元のまま) */
  readonly base: Uint8Array;
  readonly content: Uint8Array;
  readonly elements: PageElement[];
  readonly layering: Layering;
  /** 書き換えの対象になりうる文字表示の命令 */
  readonly lines: ReadonlyMap<number, TextLine>;
  /** 文字の書き換えを確かめるための PDF(読むだけ) */
  readonly planDoc: PDFDocument;
}

/** タブの中の変更(元に戻す・やり直しの単位) */
interface EditorState {
  readonly edits: ReadonlyMap<number, ElementEdit>;
  /** 描画の順番(奥から手前) */
  readonly order: readonly number[];
  /** 重なり順を動かした要素(表示用) */
  readonly moved: ReadonlySet<number>;
  /** 文字の書き換え: 文字表示の命令の位置 → 新しい文字列 */
  readonly texts: ReadonlyMap<number, string>;
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
/** 四隅の取っ手の大きさ(CSS px) */
const HANDLE_PX = 9;
/** 文字の欄を出す行数の上限(多すぎると操作しにくいため) */
const MAX_TEXT_LINES = 30;

const ORDER_BUTTONS: { move: OrderMove; label: string; key: string }[] = [
  { move: 'front', label: '最前面へ', key: 'Ctrl+Shift+]' },
  { move: 'forward', label: '前面へ', key: 'Ctrl+]' },
  { move: 'backward', label: '背面へ', key: 'Ctrl+[' },
  { move: 'back', label: '最背面へ', key: 'Ctrl+Shift+[' },
];

export interface EditorView {
  /** タブを開いたとき。page を渡すと、編集画面の並びでその位置のページを開く */
  show(page?: number): void;
  /** いま開いているページ(編集画面の並びでの位置) */
  currentPage(): number | undefined;
  /** 適用していない変更があるか */
  hasUnapplied(): boolean;
  /** タブを離れてよいか(必要なら利用者に「適用 / 破棄 / 残る」を選んでもらう) */
  confirmLeave(): Promise<boolean>;
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
  let st: EditorState = { edits: new Map(), order: [], moved: new Set(), texts: new Map() };
  let past: EditorState[] = [];
  let future: EditorState[] = [];
  /** プレビューでだけ隠す要素(保存には影響しない) */
  const hidden = new Set<number>();
  let selected: number | null = null;
  let moveEffects = true;
  let viewport: PageViewport | null = null;
  let renderDoc: PDFDocumentProxy | null = null;
  let renderToken = 0;
  /** 文字の欄で、書き換えられなかった入力(画面を描き直しても消えないように持つ) */
  const textDrafts = new Map<number, { value: string; plan: Extract<TextPlan, { ok: false }> }>();
  const planCache = new Map<string, TextPlan>();
  let pcFonts: Map<string, LocalFont> | null = null;
  const lookup = (): LocalFontLookup | undefined => (pcFonts ? (name) => pcFonts!.get(normalizeFontName(name)) : undefined);
  const ratio = () => window.devicePixelRatio || 1;

  const initialState = (s: Session): EditorState => ({ edits: new Map(), order: s.elements.map((e) => e.id), moved: new Set(), texts: new Map() });

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
      const page = work.getPage(0);
      const content = pageContentBytes(work, page);
      const elements = extractElements(work, page);
      session = {
        ref,
        base,
        content,
        elements,
        layering: analyzeLayering(lexContent(content), elements),
        lines: textLines(work, page),
        planDoc: work,
      };
      st = initialState(session);
      past = [];
      future = [];
      hidden.clear();
      textDrafts.clear();
      planCache.clear();
      selected = null;
      renderAll();
      await renderPreview();
    });
  }

  /**
   * 適用していない変更があれば、「適用して移動 / 破棄して移動 / ここに残る」を選んでもらう。
   * 移動してよければ true(適用・破棄は済ませてある)
   */
  async function confirmLeave(): Promise<boolean> {
    if (!hasUnapplied()) return true;
    const choice = await ui.choose(
      '適用していない変更があります',
      `このページで、${changedIds().size} 個の要素を変更したまま、まだ「適用」していません。移動する前に、変更をページに反映するか、破棄するかを選んでください。`,
      [
        { value: 'apply', label: '適用して移動', primary: true },
        { value: 'discard', label: '破棄して移動' },
        { value: 'stay', label: 'このページに残る' },
      ],
      'stay',
    );
    if (choice === 'stay') return false;
    if (choice === 'apply') await applyChanges();
    else discard();
    return true;
  }

  async function goTo(index: number): Promise<void> {
    if (index < 0 || index >= store.pages.length || index === pageIndexInList) return;
    if (!(await confirmLeave())) {
      pageSelect.value = String(pageIndexInList);
      return;
    }
    await openPage(index);
  }

  pageSelect.addEventListener('change', () => void goTo(Number(pageSelect.value)));
  $<HTMLButtonElement>('#editor-prev').addEventListener('click', () => void goTo(pageIndexInList - 1));
  $<HTMLButtonElement>('#editor-next').addEventListener('click', () => void goTo(pageIndexInList + 1));

  // ---------- 編集の状態 ----------

  const orderChanged = () => st.order.some((id, i) => id !== i);

  function hasUnapplied(): boolean {
    return st.edits.size > 0 || st.texts.size > 0 || orderChanged();
  }

  /** 変更した要素(移動・削除・文字の書き換え・重なり順) */
  function changedIds(): Set<number> {
    const ids = new Set(st.edits.keys());
    if (!session) return ids;
    for (const e of session.elements) if (e.events.some((ev) => st.texts.has(ev.opIndex))) ids.add(e.id);
    if (orderChanged()) for (const id of st.moved) ids.add(id);
    return ids;
  }

  function commit(next: Partial<EditorState>): void {
    past.push(st);
    future = [];
    st = { ...st, ...next };
    renderAll();
    void renderPreview();
  }

  const itemOf = (id: number): number => {
    const e = session?.elements[id];
    return e?.effectOf ?? e?.overlayOf ?? id;
  };

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
    const e = st.edits.get(id);
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
    const map = new Map(st.edits);
    for (const cid of companions(id)) {
      if (session.elements[cid].movable) map.set(cid, { ...next, anchor: current.anchor });
    }
    commit({ edits: map });
  }

  /** いまの変換に、ページ座標の点 p を中心とした k 倍の拡大縮小を重ねる(四隅の取っ手) */
  function scaleAbout(t: TransformEdit, k: number, p: readonly [number, number]): TransformEdit {
    const [ax, ay] = t.anchor;
    return { ...t, scale: t.scale * k, dx: k * (ax + t.dx - p[0]) + p[0] - ax, dy: k * (ay + t.dy - p[1]) + p[1] - ay };
  }

  function deleteSelected(): void {
    if (selected === null || !session) return;
    const map = new Map(st.edits);
    for (const cid of companions(selected)) map.set(cid, { kind: 'delete' });
    // 削除した要素の効果も消す
    for (const e of session.elements) if (e.effectOf === selected) map.set(e.id, { kind: 'delete' });
    commit({ edits: map });
  }

  function reorder(move: OrderMove): void {
    if (!session || selected === null) return;
    const target = itemOf(selected);
    const next = moveInOrder(st.order, session.layering, itemOf, target, move);
    if (!next) {
      const limits = orderLimits(st.order, session.layering, itemOf, target);
      ui.toast(limits.reorderable ? orderEdgeMessage(move) : notReorderableMessage(session.elements[target]), 'error', 'EDIT_ORDER_LIMIT');
      return;
    }
    const members = st.order.filter((id) => itemOf(id) === target);
    commit({ order: next, moved: new Set([...st.moved, ...members]) });
  }

  function orderEdgeMessage(move: OrderMove): string {
    const toFront = move === 'front' || move === 'forward';
    return `これ以上${toFront ? '手前' : '奥'}には移せません。${toFront ? '手前' : '奥'}にある要素とは描画の設定がつながっているため、入れ替えると見た目が変わってしまいます。`;
  }

  function notReorderableMessage(e: PageElement): string {
    return e.movable
      ? 'この要素は、前後の要素と描画の設定がつながっているため、重なりの順番を変えられません(入れ替えると見た目が変わってしまうため)。'
      : 'この要素は、ほかの要素と一体になっているため、重なりの順番を変えられません。';
  }

  /** 表示上の範囲(移動・拡大縮小と、文字の書き換えによる幅の変化を反映したもの) */
  function displayedBounds(e: PageElement): Rect {
    const t = transformOf(e.id);
    const b = textAdjustedBounds(e);
    return t ? transformRect(pageTransform(t), b) : b;
  }

  /** 書き換えた文字の幅の変化を、範囲に反映する(横書きの文字の目安: 書き出しの位置を固定して幅だけ変える) */
  function textAdjustedBounds(e: PageElement): Rect {
    if (!session || !e.events.some((ev) => st.texts.has(ev.opIndex))) return e.bounds;
    const visible = e.events.filter((ev) => !ev.invisible);
    return (visible.length > 0 ? visible : e.events)
      .map((ev) => {
        const text = st.texts.get(ev.opIndex);
        if (text === undefined) return ev.bounds;
        const plan = cachedPlan(ev.opIndex, text);
        const r = plan.ok ? plan.widthRatio : 1;
        return rect(ev.bounds.x0, ev.bounds.y0, ev.bounds.x0 + (ev.bounds.x1 - ev.bounds.x0) * r, ev.bounds.y1);
      })
      .reduce(unionRect);
  }

  /** 文字の書き換えを反映した要素(名前の表示用) */
  function withTexts(e: PageElement): PageElement {
    if (!e.events.some((ev) => st.texts.has(ev.opIndex))) return e;
    return { ...e, events: e.events.map((ev) => (st.texts.has(ev.opIndex) ? { ...ev, text: st.texts.get(ev.opIndex) } : ev)) };
  }

  const labelOf = (e: PageElement) => elementLabel(withTexts(e), session?.elements.map(withTexts));

  // ---------- 描画 ----------

  async function renderPreview(): Promise<void> {
    if (!session) return;
    const token = ++renderToken;
    const s = session;
    const work = await loadPdfForEditOrThrow(s.base);
    const page = work.getPage(0);
    const previewEdits = new Map(st.edits);
    for (const id of hidden) previewEdits.set(id, { kind: 'delete' });
    const textSplices = await textEditSplices(work, page, st.texts, lookup());
    page.node.set(PDFName.of('Contents'), work.context.register(work.context.flateStream(applyElementEdits(s.content, s.elements, previewEdits, st.order, textSplices))));
    const doc = await openForRender(await work.save());
    if (token !== renderToken) {
      await doc.loadingTask.destroy();
      return;
    }
    await renderDoc?.loadingTask.destroy();
    renderDoc = doc;
    const pdfPage = await doc.getPage(1);
    const rotation = normalizeRotation(pdfPage.rotate + s.ref.rotation);
    const base = pdfPage.getViewport({ scale: 1, rotation });
    const maxW = Math.max(240, stage.clientWidth - 64);
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

  interface VRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** 選んだ要素の枠の四隅(キャンバスの画素)。左上・右上・右下・左下の順 */
  function cornersOf(v: VRect): [number, number][] {
    return [
      [v.x, v.y],
      [v.x + v.w, v.y],
      [v.x + v.w, v.y + v.h],
      [v.x, v.y + v.h],
    ];
  }

  const canResize = (e: PageElement) => e.movable && st.edits.get(e.id)?.kind !== 'delete';

  function drawOverlay(ghost?: (v: VRect) => VRect): void {
    const ctx = overlay.getContext('2d')!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!session || !viewport || selected === null) return;
    const r = ratio();
    const sel = session.elements[selected];
    const box = (e: PageElement, color: string, dash: number[]): VRect => {
      const raw = toViewportRect(viewport!, displayedBounds(e));
      const v = ghost ? ghost(raw) : raw;
      ctx.setLineDash(dash.map((d) => d * r));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * r;
      ctx.strokeRect(v.x, v.y, v.w, v.h);
      return v;
    };
    for (const e of session.elements) if (e.effectOf === selected) box(e, '#b197fc', [5, 3]);
    const v = box(sel, sel.movable ? '#34c6ea' : '#ff5aa8', []);
    ctx.setLineDash([]);
    if (!canResize(sel)) return;
    // 四隅の取っ手(つまんで大きさを変える)
    const size = HANDLE_PX * r;
    for (const [x, y] of cornersOf(v)) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#34c6ea';
      ctx.lineWidth = 1.5 * r;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    }
  }

  function renderAll(): void {
    const hasPages = store.pages.length > 0;
    empty.hidden = hasPages && !!session;
    stage.hidden = !session;
    undoButton.disabled = past.length === 0;
    redoButton.disabled = future.length === 0;
    const changed = hasUnapplied();
    applyButton.disabled = !changed;
    discardButton.disabled = !changed;
    status.textContent = changed ? `適用していない変更: ${changedIds().size} 個の要素` : '';
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
    const changed = changedIds();
    const pos = new Map(st.order.map((id, i) => [id, i]));
    const row = (e: PageElement, nested: boolean): HTMLLIElement => {
      const li = el('li', `layer-row${nested ? ' is-nested' : ''}${e.id === selected ? ' is-selected' : ''}`);
      li.dataset.id = String(e.id);
      const eye = el('button', hidden.has(e.id) ? 'layer-eye is-off' : 'layer-eye');
      eye.type = 'button';
      eye.innerHTML = hidden.has(e.id)
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6C3.9 8.3 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.3-1"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
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
      label.append(icon, el('span', 'layer-name', nested && e.overlayOf !== undefined ? `検索用の見えない文字「${(e.events[0].text ?? '').slice(0, 10)}」` : labelOf(e)));
      const chips = el('span', 'layer-chips');
      if (e.effectOf !== undefined) chips.append(chip('効果(推定)', 'is-effect'));
      if (e.transparent && e.effectOf === undefined) chips.append(chip('半透明'));
      if (!e.movable) chips.append(chip('固定', 'is-fixed'));
      const edit = st.edits.get(e.id);
      if (edit?.kind === 'delete') chips.append(chip('削除', 'is-deleted'));
      else if (changed.has(e.id)) chips.append(chip('変更', 'is-changed'));
      li.append(eye, label, chips);
      li.addEventListener('click', () => select(e.id));
      return li;
    };
    const nodes: HTMLLIElement[] = [];
    const byPosDesc = (a: PageElement, b: PageElement) => pos.get(b.id)! - pos.get(a.id)!;
    // 上が手前: 描画の順番の逆。効果と見えない文字は、関連する要素の下に字下げして並べる
    for (const id of [...st.order].reverse()) {
      const e = els[id];
      if (e.effectOf !== undefined || e.overlayOf !== undefined) continue;
      if (e.invisible && !showInvisible) continue;
      nodes.push(row(e, false));
      for (const child of els.filter((x) => x.effectOf === e.id).sort(byPosDesc)) nodes.push(row(child, true));
      if (showInvisible) for (const child of els.filter((x) => x.overlayOf === e.id).sort(byPosDesc)) nodes.push(row(child, true));
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

  function button(label: string, cls = 'btn'): HTMLButtonElement {
    const b = el('button', cls, label);
    b.type = 'button';
    return b;
  }

  function renderProps(): void {
    if (!session || selected === null || !viewport) {
      props.replaceChildren(
        el('p', 'hint', 'ページの上の要素か、下のレイヤーを選ぶと、ここに詳しい情報が出ます。ドラッグや矢印キーで動かせます。四隅の取っ手をつまむと、大きさを変えられます。'),
      );
      return;
    }
    const e = session.elements[selected];
    const box = el('div', 'props-box');
    box.append(el('h3', 'props-title', labelOf(e)));
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

    box.append(positionForm(e));
    if (effects) {
      const line = el('label', 'checkbox-line');
      const check = el('input');
      check.type = 'checkbox';
      check.checked = moveEffects;
      check.addEventListener('change', () => (moveEffects = check.checked));
      line.append(check, ' 効果も一緒に動かす');
      box.append(line);
    }
    box.append(orderSection(e));
    const text = textSection(e);
    if (text) box.append(text);

    const actions = el('div', 'props-actions');
    const del = button('削除', 'btn btn-danger');
    del.addEventListener('click', deleteSelected);
    const ownTexts = (x: PageElement) => x.events.filter((ev) => st.texts.has(ev.opIndex)).map((ev) => ev.opIndex);
    const reset = button('この要素の変更を戻す');
    reset.disabled = !st.edits.has(e.id) && ownTexts(e).length === 0;
    reset.addEventListener('click', () => {
      const map = new Map(st.edits);
      const texts = new Map(st.texts);
      for (const cid of companions(e.id)) map.delete(cid);
      for (const x of session!.elements) if (x.effectOf === e.id) map.delete(x.id);
      for (const op of ownTexts(e)) texts.delete(op);
      commit({ edits: map, texts });
    });
    actions.append(del, reset);
    box.append(actions);
    props.replaceChildren(box);
  }

  function positionForm(e: PageElement): HTMLFormElement {
    const v = toViewportRect(viewport!, displayedBounds(e));
    const pxPerMm = viewport!.scale * (72 / 25.4);
    const form = el('form', 'props-form');
    const row1 = el('div', 'field-row');
    row1.append(
      numberInput('x', v.x / pxPerMm, 0.5, '左から(mm)'),
      numberInput('y', v.y / pxPerMm, 0.5, '上から(mm)'),
      numberInput('scale', (transformOf(e.id)?.scale ?? 1) * 100, 5, '大きさ(%)'),
    );
    form.append(row1, el('p', 'hint', `大きさ: ${(v.w / pxPerMm).toFixed(1)} × ${(v.h / pxPerMm).toFixed(1)}mm`));
    for (const input of form.querySelectorAll('input')) input.disabled = !e.movable;
    form.addEventListener('submit', (ev) => ev.preventDefault());
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
    return form;
  }

  function orderSection(e: PageElement): HTMLElement {
    const target = itemOf(e.id);
    const limits = orderLimits(st.order, session!.layering, itemOf, target);
    const wrap = el('div', 'props-order');
    wrap.append(el('span', 'field-label', '重なり順'));
    const row = el('div', 'props-order-buttons');
    for (const b of ORDER_BUTTONS) {
      const btn = button(b.label, 'btn btn-small');
      btn.dataset.order = b.move;
      btn.title = `${b.label}(${b.key})`;
      btn.disabled = b.move === 'front' || b.move === 'forward' ? !limits.forward : !limits.backward;
      btn.addEventListener('click', () => reorder(b.move));
      row.append(btn);
    }
    wrap.append(row);
    if (!limits.reorderable) wrap.append(el('p', 'hint', notReorderableMessage(session!.elements[target])));
    return wrap;
  }

  function cachedPlan(opIndex: number, value: string): TextPlan {
    const key = `${opIndex}:${value}`;
    let plan = planCache.get(key);
    if (!plan) {
      plan = planTextEdit(session!.planDoc, session!.planDoc.getPage(0), opIndex, value, lookup());
      planCache.set(key, plan);
    }
    return plan;
  }

  function textSection(e: PageElement): HTMLElement | null {
    const s = session!;
    if (st.edits.get(e.id)?.kind === 'delete') return null;
    const events = e.events.filter((ev) => ev.kind === 'text' && !ev.invisible && s.lines.has(ev.opIndex));
    if (events.length === 0) {
      // Office が画像にした文字(効果付きの文字)
      if (s.elements.some((x) => x.overlayOf === e.id)) {
        return el('p', 'hint', 'この文字は画像になっているため、文字としては変えられません(元のファイルで直してください)。');
      }
      return null;
    }
    const wrap = el('div', 'props-text');
    wrap.append(el('span', 'field-label', '文字を変える'));
    const needPc = new Set<string>();
    for (const ev of events.slice(0, MAX_TEXT_LINES)) {
      const line = s.lines.get(ev.opIndex)!;
      const draft = textDrafts.get(ev.opIndex);
      const value = draft?.value ?? st.texts.get(ev.opIndex) ?? line.text;
      const item = el('div', 'text-line');
      const input = el('input', 'input-text text-line-input');
      input.type = 'text';
      input.value = value;
      input.dataset.op = String(ev.opIndex);
      input.setAttribute('aria-label', `文字(元: ${line.text})`);
      // 書き換えられないフォント(許諾・形式)は、最初から欄を止めて理由を出す
      const probe = cachedPlan(ev.opIndex, line.text);
      const plan = draft?.plan ?? (st.texts.has(ev.opIndex) ? cachedPlan(ev.opIndex, value) : probe);
      if (!probe.ok && probe.code !== 'TEXT_FONT_LICENSE_UNKNOWN') input.disabled = true;
      input.addEventListener('change', () => changeText(ev.opIndex, input.value));
      input.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') {
          k.preventDefault();
          input.blur();
        }
        k.stopPropagation(); // 矢印キーや Delete で要素を動かさない
      });
      item.append(input);
      if (!plan.ok) {
        item.append(el('p', 'text-line-msg is-error', TEXT_EDIT_MESSAGES[plan.code](plan.fontName, plan.detail)));
        if (plan.code === 'TEXT_GLYPH_MISSING' || plan.code === 'TEXT_FONT_LICENSE_UNKNOWN') needPc.add(line.fontName);
      } else if (st.texts.has(ev.opIndex)) {
        for (const w of textPlanWarnings(plan)) item.append(el('p', 'text-line-msg is-warn', w));
      }
      wrap.append(item);
    }
    if (events.length > MAX_TEXT_LINES) wrap.append(el('p', 'hint', `ほかに ${events.length - MAX_TEXT_LINES} 行あります(元のファイルで直してください)。`));
    wrap.append(el('p', 'hint', 'PDF の中の文字の記録 1 つ(多くは 1 行)ごとに変えられます。Enter で反映します。後ろの文字は自動では詰め直されません。'));
    if (needPc.size > 0 && !pcFonts) {
      if (supportsPcFonts()) {
        const pc = button('PC のフォントで補う', 'btn btn-small');
        pc.addEventListener('click', () => void usePcFonts([...needPc]));
        wrap.append(
          pc,
          el('p', 'hint', 'この PC に同じフォントが入っていれば、足りない字をそこから補えます(フォントの許諾も確認します)。初めて使うときは、ブラウザがフォントへのアクセスの許可を求めます(フォントはこの PC の中で読むだけで、送信しません)。'),
        );
      } else {
        wrap.append(el('p', 'hint', 'PC のフォントで足りない字を補う機能は、Chrome または Edge でだけ使えます。'));
      }
    }
    return wrap;
  }

  function changeText(opIndex: number, value: string): void {
    if (!session) return;
    const line = session.lines.get(opIndex);
    if (!line) return;
    const texts = new Map(st.texts);
    if (value === line.text) {
      textDrafts.delete(opIndex);
      texts.delete(opIndex);
      if (st.texts.has(opIndex)) commit({ texts });
      else renderAll();
      return;
    }
    const plan = cachedPlan(opIndex, value);
    if (!plan.ok) {
      textDrafts.set(opIndex, { value, plan });
      renderAll();
      return;
    }
    textDrafts.delete(opIndex);
    texts.set(opIndex, value);
    commit({ texts });
  }

  async function usePcFonts(fontNames: string[]): Promise<void> {
    await ui.run('PC のフォントを探しています…', async () => {
      const fonts = await findPcFonts(fontNames);
      pcFonts = fonts;
      planCache.clear();
      // 書き換えられなかった入力を、PC のフォントで確かめ直す
      const drafts = [...textDrafts];
      textDrafts.clear();
      const texts = new Map(st.texts);
      for (const [opIndex, d] of drafts) {
        const plan = cachedPlan(opIndex, d.value);
        if (plan.ok) texts.set(opIndex, d.value);
        else textDrafts.set(opIndex, { value: d.value, plan });
      }
      const found = fontNames.filter((n) => fonts.has(normalizeFontName(n)));
      ui.toast(found.length > 0 ? `PC のフォント「${found.join('」「')}」を使えるようにしました。` : 'この PC に、同じフォントが見つかりませんでした。', found.length > 0 ? 'info' : 'error');
      if (texts.size !== st.texts.size) commit({ texts });
      else renderAll();
    });
  }

  function select(id: number | null): void {
    if (!session) return;
    // 効果を選んだら、本体を選ぶ(本体と一緒に扱う)
    selected = id !== null && session.elements[id].effectOf !== undefined ? session.elements[id].effectOf! : id;
    renderAll();
  }

  // ---------- ページの上での操作 ----------

  /** マウスの位置(キャンバスの画素) */
  function canvasPointAt(ev: MouseEvent): [number, number] {
    const r = overlay.getBoundingClientRect();
    return [(ev.clientX - r.left) * ratio(), (ev.clientY - r.top) * ratio()];
  }

  function pdfPointAt(ev: MouseEvent): [number, number] {
    const [x, y] = canvasPointAt(ev);
    return viewport!.convertToPdfPoint(x, y) as [number, number];
  }

  function hitTest(x: number, y: number): number | null {
    if (!session) return null;
    const inside = (e: PageElement) => {
      const b = displayedBounds(e);
      return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
    };
    const pos = new Map(st.order.map((id, i) => [id, i]));
    const candidates = session.elements.filter((e) => !hidden.has(e.id) && !e.invisible && st.edits.get(e.id)?.kind !== 'delete' && inside(e));
    // 手前(後に描かれたもの)を優先し、そのなかで小さいもの(背景より中身)を選ぶ
    candidates.sort((a, b) => pos.get(b.id)! - pos.get(a.id)!);
    const top = candidates.slice(0, 4).sort((a, b) => rectWidth(a.bounds) * rectHeight(a.bounds) - rectWidth(b.bounds) * rectHeight(b.bounds));
    return top[0]?.id ?? null;
  }

  /** 選んだ要素の取っ手の上なら、その角の番号(左上 0・右上 1・右下 2・左下 3) */
  function handleAt(px: number, py: number): number | null {
    if (!session || !viewport || selected === null || !canResize(session.elements[selected])) return null;
    const v = toViewportRect(viewport, displayedBounds(session.elements[selected]));
    const tolerance = HANDLE_PX * ratio();
    const index = cornersOf(v).findIndex(([x, y]) => Math.abs(px - x) <= tolerance && Math.abs(py - y) <= tolerance);
    return index >= 0 ? index : null;
  }

  type Drag =
    | { kind: 'move'; startX: number; startY: number; pdf: [number, number]; id: number }
    | { kind: 'resize'; id: number; fixed: [number, number]; corner: [number, number]; k: number };
  let drag: Drag | null = null;

  /** 取っ手の位置 mouse から、反対の角を中心にした拡大率を求める(縦横比は保つ) */
  function resizeFactor(d: Extract<Drag, { kind: 'resize' }>, mouse: [number, number]): number {
    const vx = d.corner[0] - d.fixed[0];
    const vy = d.corner[1] - d.fixed[1];
    const len2 = vx * vx + vy * vy;
    if (len2 <= 0) return 1;
    const k = ((mouse[0] - d.fixed[0]) * vx + (mouse[1] - d.fixed[1]) * vy) / len2;
    // 小さくしすぎて消えないように、取っ手 2 つ分の大きさを下限にする
    const min = (HANDLE_PX * 2 * ratio()) / Math.sqrt(len2);
    return Math.max(min, k);
  }

  overlay.addEventListener('mousedown', (ev) => {
    if (!session || !viewport) return;
    const [px, py] = canvasPointAt(ev);
    const corner = handleAt(px, py);
    if (corner !== null && selected !== null) {
      const v = toViewportRect(viewport, displayedBounds(session.elements[selected]));
      const corners = cornersOf(v);
      drag = { kind: 'resize', id: selected, corner: corners[corner], fixed: corners[(corner + 2) % 4], k: 1 };
      ev.preventDefault();
      stage.focus();
      return;
    }
    const [x, y] = pdfPointAt(ev);
    const hit = hitTest(x, y);
    if (hit === null) {
      select(null);
      return;
    }
    const target = session.elements[hit].effectOf ?? hit;
    if (target !== selected) select(target);
    if (session.elements[target].movable) drag = { kind: 'move', startX: ev.clientX, startY: ev.clientY, pdf: [x, y], id: target };
    stage.focus();
  });

  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    if (drag.kind === 'move') {
      const dx = (ev.clientX - drag.startX) * ratio();
      const dy = (ev.clientY - drag.startY) * ratio();
      drawOverlay((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    const d = drag;
    d.k = resizeFactor(d, canvasPointAt(ev));
    const [fx, fy] = d.fixed;
    drawOverlay((v) => ({ x: fx + (v.x - fx) * d.k, y: fy + (v.y - fy) * d.k, w: v.w * d.k, h: v.h * d.k }));
  });

  // 取っ手の上では、大きさを変えるカーソルにする
  overlay.addEventListener('mousemove', (ev) => {
    if (drag || !session || !viewport) return;
    const [px, py] = canvasPointAt(ev);
    const corner = handleAt(px, py);
    if (corner !== null) {
      overlay.style.cursor = corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
      return;
    }
    const [x, y] = viewport.convertToPdfPoint(px, py) as [number, number];
    const hit = hitTest(x, y);
    overlay.style.cursor = hit !== null && (session.elements[hit].effectOf ?? hit) === selected && session.elements[selected].movable ? 'move' : 'pointer';
  });

  window.addEventListener('mouseup', (ev) => {
    if (!drag || !viewport) return;
    const d = drag;
    drag = null;
    if (d.kind === 'resize') {
      if (Math.abs(d.k - 1) < 0.002) {
        drawOverlay();
        return;
      }
      const p = viewport.convertToPdfPoint(d.fixed[0], d.fixed[1]) as [number, number];
      editTransform(d.id, (t) => scaleAbout(t, d.k, p));
      return;
    }
    if (Math.abs(ev.clientX - d.startX) < 2 && Math.abs(ev.clientY - d.startY) < 2) {
      drawOverlay();
      return;
    }
    const [x, y] = pdfPointAt(ev);
    editTransform(d.id, (t) => ({ ...t, dx: t.dx + (x - d.pdf[0]), dy: t.dy + (y - d.pdf[1]) }));
  });

  stage.addEventListener('keydown', (ev) => {
    if (!session || selected === null || !viewport) return;
    // 重なり順: Ctrl+] 前面へ / Ctrl+[ 背面へ(Shift で最前面・最背面)。キー配列によらず、入力された文字で判定する
    if (ev.ctrlKey || ev.metaKey) {
      const moves: Record<string, OrderMove> = { ']': 'forward', '}': 'front', '[': 'backward', '{': 'back' };
      const move = moves[ev.key];
      if (move) {
        ev.preventDefault();
        reorder(ev.shiftKey && move === 'forward' ? 'front' : ev.shiftKey && move === 'backward' ? 'back' : move);
      }
      return;
    }
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
    future.push(st);
    st = prev;
    textDrafts.clear();
    renderAll();
    void renderPreview();
  });
  redoButton.addEventListener('click', () => {
    const next = future.pop();
    if (!next) return;
    past.push(st);
    st = next;
    textDrafts.clear();
    renderAll();
    void renderPreview();
  });
  discardButton.addEventListener('click', () => discard());
  showHidden.addEventListener('change', renderLayers);

  // 窓の大きさが変わったら、プレビューを描き直す(少し待ってから 1 回だけ)
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.body.dataset.mode === 'editor' && session) void renderPreview();
    }, 200);
  });

  applyButton.addEventListener('click', () => void applyChanges());

  async function applyChanges(): Promise<void> {
    if (!session || !hasUnapplied()) return;
    const s = session;
    const state = st;
    await ui.run('ページに反映しています…', async () => {
      const doc = await loadPdfForEditOrThrow(store.sources.get(s.ref.sourceId)!.bytes);
      const page = doc.getPage(s.ref.pageIndex);
      // コンテンツは、文字の書き換え(フォントの追加)の前に取り出す
      const content = pageContentBytes(doc, page);
      const textSplices = await textEditSplices(doc, page, state.texts, lookup());
      const next = applyElementEdits(content, s.elements, state.edits, state.order, textSplices);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(next)));
      const count = changedIds().size;
      st = initialState(s);
      past = [];
      future = [];
      textDrafts.clear();
      store.replaceSources(new Map([[s.ref.sourceId, await doc.save({ useObjectStreams: true })]]));
      ui.toast(`${count} 個の要素の変更を、ページに反映しました。編集画面の「元に戻す」で取り消せます。`);
    });
    // replaceSources で並びが変わる → store の通知で、同じ位置のページを開き直す
  }

  function discard(): void {
    if (session) st = initialState(session);
    past = [];
    future = [];
    textDrafts.clear();
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
    show(page) {
      refreshPageOptions();
      if (page !== undefined && page >= 0 && page < store.pages.length && (!session || page !== pageIndexInList || pendingReload)) {
        pendingReload = false;
        pageIndexInList = page;
        pageSelect.value = String(page);
        void openPage(page);
      } else if (!session || pendingReload) void reloadCurrent();
      else void renderPreview();
      renderAll();
    },
    currentPage: () => (session ? pageIndexInList : undefined),
    hasUnapplied,
    confirmLeave,
    discard,
  };
}
