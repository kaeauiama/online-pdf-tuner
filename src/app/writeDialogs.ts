// ページ番号・文字入れ(M5)のダイアログ。入力に合わせてプレビューを描き、適用すると元のファイルの新しい版を作る。
import { degrees, PDFDocument } from '@cantoo/pdf-lib';
import { normalizeRotation, type PageRef, type SourceId } from '../core/pageList.ts';
import { loadPdfForEditOrThrow } from '../core/pdfLoad.ts';
import { openForRender, renderThumbnail } from '../render/pdfjs.ts';
import { embedJapaneseFont, type FontWeight } from '../text/fonts.ts';
import {
  INK_COLORS,
  missingChars,
  PAGE_NUMBER_FORMATS,
  planPageNumbers,
  stampText,
  type Anchor,
  type InkColor,
  type PageNumberFormat,
  type StampSpec,
} from '../text/stamp.ts';
import type { Store } from './store.ts';
import { $, type Ui } from './ui.ts';

/** 1 ページに描く内容 */
interface PageWrite {
  readonly ref: PageRef;
  readonly text: string;
  readonly spec: StampSpec;
}

interface WriteJob {
  readonly weight: FontWeight;
  readonly writes: readonly PageWrite[];
}

const PREVIEW_SIZE = 260;

function fillSelect(select: HTMLSelectElement, options: Record<string, string>): void {
  select.replaceChildren(...Object.entries(options).map(([value, label]) => new Option(label, value)));
}

/** ジョブを元のファイルに書き込み、ファイルごとの新しい版を返す */
async function applyWrites(store: Store, job: WriteJob): Promise<Map<SourceId, Uint8Array>> {
  const bySource = new Map<SourceId, PageWrite[]>();
  for (const w of job.writes) bySource.set(w.ref.sourceId, [...(bySource.get(w.ref.sourceId) ?? []), w]);
  const out = new Map<SourceId, Uint8Array>();
  for (const [sourceId, writes] of bySource) {
    const doc = await loadPdfForEditOrThrow(store.sources.get(sourceId)!.bytes);
    const font = await embedJapaneseFont(doc, job.weight);
    const missing = missingChars(font, writes.map((w) => w.text).join(''));
    if (missing.length > 0) throw new Error(`MISSING:${missing.join('')}`);
    for (const w of writes) {
      const page = doc.getPage(w.ref.pageIndex);
      // 画面上の向き = 元のページの回転 + 編集画面での回転
      stampText(page, font, w.spec, w.text, normalizeRotation(page.getRotation().angle + w.ref.rotation));
    }
    out.set(sourceId, await doc.save({ useObjectStreams: true }));
  }
  return out;
}

/** 最初の対象ページだけを書き込んだ見本を、canvas に描く */
async function renderPreview(store: Store, job: WriteJob, canvas: HTMLCanvasElement): Promise<void> {
  const first = job.writes[0];
  if (!first) {
    canvas.width = 0;
    return;
  }
  const src = await loadPdfForEditOrThrow(store.sources.get(first.ref.sourceId)!.bytes);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const [page] = await doc.copyPages(src, [first.ref.pageIndex]);
  doc.addPage(page);
  const rotation = normalizeRotation(page.getRotation().angle + first.ref.rotation);
  page.setRotation(degrees(rotation));
  const font = await embedJapaneseFont(doc, job.weight);
  const missing = missingChars(font, job.writes.map((w) => w.text).join(''));
  if (missing.length > 0) throw new Error(`MISSING:${missing.join('')}`);
  stampText(page, font, first.spec, first.text, rotation);
  const render = await openForRender(await doc.save());
  await renderThumbnail(render, 0, canvas, PREVIEW_SIZE);
  await render.loadingTask.destroy();
}

function setupDialog(
  store: Store,
  ui: Ui,
  options: {
    dialogId: string;
    openAction: string;
    buildJob: (data: FormData) => WriteJob | string;
    doneMessage: (count: number) => string;
  },
): void {
  const dialog = $<HTMLDialogElement>(`#${options.dialogId}`);
  const form = dialog.querySelector('form')!;
  const canvas = dialog.querySelector<HTMLCanvasElement>('canvas.write-preview')!;
  const error = dialog.querySelector<HTMLElement>('.form-error')!;
  let timer = 0;
  let token = 0;

  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const job = options.buildJob(new FormData(form));
      const my = ++token;
      if (typeof job === 'string') {
        error.textContent = job;
        return;
      }
      error.textContent = '';
      try {
        await renderPreview(store, job, canvas);
      } catch (e) {
        if (my !== token) return;
        error.textContent =
          e instanceof Error && e.message.startsWith('MISSING:')
            ? missingMessage(e.message.slice(8))
            : 'プレビューを表示できませんでした。';
      }
    }, 250);
  };

  $<HTMLButtonElement>(`[data-action="${options.openAction}"]`).addEventListener('click', () => {
    error.textContent = '';
    dialog.showModal();
    refresh();
  });
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const job = options.buildJob(new FormData(form));
    if (typeof job === 'string') {
      error.textContent = job;
      return;
    }
    void ui.run('書き込んでいます…', async () => {
      try {
        const replacements = await applyWrites(store, job);
        store.replaceSources(replacements);
        dialog.close();
        ui.toast(options.doneMessage(job.writes.length));
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('MISSING:')) {
          error.textContent = missingMessage(err.message.slice(8));
          return;
        }
        throw err;
      }
    });
  });
}

function missingMessage(chars: string): string {
  return `「${chars}」は、同梱のフォント(BIZ UDPゴシック。JIS 第1・第2水準などの範囲)にない字のため書けません。別の字に変えてください。`;
}

export function setupWriteDialogs(store: Store, ui: Ui): void {
  // ---------- ページ番号 ----------
  const numberForm = $<HTMLFormElement>('#number-form');
  fillSelect(numberForm.querySelector('select[name="format"]')!, Object.fromEntries(Object.entries(PAGE_NUMBER_FORMATS).map(([k, v]) => [k, v.label])));
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[name="color"]')) {
    fillSelect(select, Object.fromEntries(Object.entries(INK_COLORS).map(([k, v]) => [k, v.label])));
  }

  setupDialog(store, ui, {
    dialogId: 'number-dialog',
    openAction: 'open-numbers',
    buildJob: (data) => {
      const pages = store.pages;
      if (pages.length === 0) return 'ページがありません。';
      const start = Number(data.get('start'));
      const skip = Number(data.get('skip'));
      const size = Number(data.get('size'));
      const margin = Number(data.get('margin'));
      if (!Number.isInteger(start) || !Number.isInteger(skip) || skip < 0 || skip >= pages.length) return '開始番号と、番号を入れないページの数を確かめてください。';
      if (!(size > 0 && size <= 72) || !(margin >= 0 && margin <= 50)) return '文字の大きさ(1〜72pt)と端からの距離(0〜50mm)を確かめてください。';
      const format = PAGE_NUMBER_FORMATS[String(data.get('format')) as PageNumberFormat];
      const position = String(data.get('position'));
      const { numbers, last } = planPageNumbers(pages.length, start, skip);
      const writes: PageWrite[] = [...numbers].map(([index, n]) => {
        const anchor = (position === 'outside' ? (n % 2 === 1 ? 'bottom-right' : 'bottom-left') : position) as Anchor;
        const horizontalMargin = anchor.endsWith('center') ? 0 : margin;
        return {
          ref: pages[index],
          text: format.format(n, last),
          spec: { sizePt: size, color: String(data.get('color')) as InkColor, anchor, marginMm: { x: horizontalMargin, y: margin } },
        };
      });
      return { weight: data.get('bold') === 'on' ? 'Bold' : 'Regular', writes };
    },
    doneMessage: (n) => `${n} ページにページ番号を入れました。元に戻すには Ctrl+Z を押してください。`,
  });

  // ---------- 文字入れ ----------
  setupDialog(store, ui, {
    dialogId: 'text-dialog',
    openAction: 'open-text',
    buildJob: (data) => {
      const raw = String(data.get('text') ?? '').replace(/\r\n/g, '\n');
      if (raw.trim() === '') return '入れる文字を書いてください。';
      const size = Number(data.get('size'));
      const mx = Number(data.get('marginX'));
      const my = Number(data.get('marginY'));
      if (!(size > 0 && size <= 200)) return '文字の大きさは 1〜200pt にしてください。';
      if (!Number.isFinite(mx) || !Number.isFinite(my)) return '位置の数値を確かめてください。';
      const selectedOnly = data.get('target') === 'selected';
      const targets = store.pages.map((ref, i) => ({ ref, i })).filter(({ ref }) => !selectedOnly || store.selection.has(ref.key));
      if (targets.length === 0) return selectedOnly ? 'ページが選択されていません。' : 'ページがありません。';
      const total = store.pages.length;
      const spec: StampSpec = {
        sizePt: size,
        color: String(data.get('color')) as InkColor,
        anchor: String(data.get('anchor')) as Anchor,
        marginMm: { x: mx, y: my },
      };
      return {
        weight: data.get('bold') === 'on' ? 'Bold' : 'Regular',
        writes: targets.map(({ ref, i }) => ({ ref, spec, text: raw.replaceAll('{page}', String(i + 1)).replaceAll('{total}', String(total)) })),
      };
    },
    doneMessage: (n) => `${n} ページに文字を入れました。元に戻すには Ctrl+Z を押してください。`,
  });
}
