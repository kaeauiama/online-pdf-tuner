// 非対応・エラーの理由コード。UI には message を、ログやテストには code を使う。
// 利用者は DTP の専門知識がない人も想定しているので(D-011)、message は「何が起きたか」と「次にどうすればよいか」を書く。

export const REASONS = {
  INVALID_PDF: {
    message: 'PDF として読み込めませんでした。ファイルが壊れているか、PDF ではない可能性があります。',
  },
  UNSUPPORTED_ENCRYPTED_PDF: {
    message:
      'パスワードや編集制限が設定された PDF は扱えません。作成者に、保護なしの PDF を用意してもらってください。',
  },
  RANGE_EMPTY: {
    message: 'ページ範囲が入力されていません。例: 1-3, 5, 8-',
  },
  RANGE_SYNTAX: {
    message: 'ページ範囲の書き方が正しくありません。例: 1-3, 5, 8-(「8-」は 8 ページから最後まで)',
  },
  RANGE_OUT_OF_BOUNDS: {
    message: '存在しないページ番号が含まれています。',
  },
  NOTHING_SELECTED: {
    message: 'ページが選択されていません。',
  },
  NO_PAGES: {
    message: 'ページがありません。先に PDF を追加してください。',
  },
  UNSUPPORTED_BROWSER_FEATURE: {
    message: 'この機能は、Chrome または Edge でだけ使えます。',
  },
  LOCAL_FONTS_DENIED: {
    message: 'PC のフォントの読み取りが許可されませんでした。使う場合は、ブラウザのアドレスバーのサイト設定で「フォント」を許可してください。',
  },
  PRINT_FIX_SIZE_UNKNOWN: {
    message: '仕上がりサイズが分からないページがあるため、入稿用 PDF を作れません。「仕上がりサイズ」を選んでから、もう一度チェックしてください。',
  },
} as const satisfies Record<string, { message: string }>;

export type ReasonCode = keyof typeof REASONS;

export class ReasonError extends Error {
  readonly code: ReasonCode;
  readonly detail?: string;

  constructor(code: ReasonCode, detail?: string) {
    super(detail ? `${REASONS[code].message}(${detail})` : REASONS[code].message);
    this.name = 'ReasonError';
    this.code = code;
    this.detail = detail;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: ReasonCode; detail?: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: ReasonCode, detail?: string): Result<T> => ({ ok: false, code, detail });
