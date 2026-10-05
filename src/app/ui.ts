// 通知と「処理中」表示。編集画面と入稿チェック画面で共有する。
import { REASONS, ReasonError, type ReasonCode } from '../core/reasons.ts';

export function $<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface Ui {
  toast(message: string, kind?: 'info' | 'error', code?: string): void;
  toastReason(code: ReasonCode, detail?: string): void;
  /** 重い処理の前に「処理中」を表示し、描画の機会を与えてから実行する。例外は通知に変える */
  run(label: string, task: (progress: (text: string) => void) => Promise<void>): Promise<void>;
}

export function createUi(): Ui {
  const busy = $<HTMLElement>('#busy');
  const busyText = $<HTMLElement>('#busy-text');
  const toasts = $<HTMLElement>('#toasts');

  function toast(message: string, kind: 'info' | 'error' = 'info', code?: string): void {
    const item = el('div', `toast toast-${kind}`);
    item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    item.append(el('p', 'toast-text', message));
    if (code) item.append(el('p', 'toast-code', code));
    const close = el('button', 'toast-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    close.addEventListener('click', () => item.remove());
    item.append(close);
    toasts.append(item);
    setTimeout(() => item.remove(), kind === 'error' ? 12_000 : 5_000);
  }

  function toastReason(code: ReasonCode, detail?: string): void {
    toast(detail ? `${detail}: ${REASONS[code].message}` : REASONS[code].message, 'error', code);
  }

  async function run(label: string, task: (progress: (text: string) => void) => Promise<void>): Promise<void> {
    busyText.textContent = label;
    busy.hidden = false;
    // タブが裏にあると requestAnimationFrame が呼ばれないため、タイマーとの早い方で先へ進む
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      setTimeout(resolve, 50);
    });
    try {
      await task((text) => (busyText.textContent = text));
    } catch (e) {
      if (e instanceof ReasonError) {
        toastReason(e.code, e.detail);
      } else {
        console.error(e);
        toast('予期しないエラーが発生しました。ファイルが特殊な形式の可能性があります。', 'error', 'UNEXPECTED_ERROR');
      }
    } finally {
      busy.hidden = true;
    }
  }

  return { toast, toastReason, run };
}
