// 誤植修正で、PC に入っているフォントから足りない字を補う(D-027)。
// PC のフォントの読み取りは Local Font Access API(Chrome / Edge のみ、利用者の許可が必要)。
// ファイルは PC の中で読むだけで、どこにも送らない(HC-1)。
import { permissionOf, type EmbeddingPermission } from '../pdf/fonts.ts';
import { ReasonError } from '../core/reasons.ts';

export interface LocalFont {
  /** 表示用の名前 */
  readonly name: string;
  readonly postscriptName: string;
  /** フォントファイル(TTC の場合はコレクション全体) */
  readonly bytes: Uint8Array;
  /** TTC などのコレクションか(埋め込むときに、名前で書体を選ぶ必要がある) */
  readonly isCollection: boolean;
  readonly permission: EmbeddingPermission;
  hasChar(char: string): boolean;
  /** 字幅(1000 = 1em) */
  widthOf(char: string): number;
}

/**
 * フォント名の比較用: サブセットの印(Office などの "ABCDEF+" / pdf-lib の "-1234")・",Bold" などの装飾・記号を除き、小文字にする
 */
export function normalizeFontName(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-\d{3,}$/, '')
    .replace(/,.*$/, '')
    .replace(/[\s\-_]/g, '')
    .toLowerCase();
}

interface FontkitFace {
  readonly unitsPerEm: number;
  readonly postscriptName: string | null;
  readonly fullName: string | null;
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { advanceWidth: number } | null;
}

/** fontkit の OS/2 テーブルから fsType を数値で読む(fontkit はビットごとの真偽値で返すことがある) */
function fsTypeOf(face: FontkitFace): number | undefined {
  const raw = (face as unknown as { 'OS/2'?: { fsType?: number | Record<string, boolean> } })['OS/2']?.fsType;
  if (typeof raw === 'number') return raw;
  if (!raw) return undefined;
  return (raw.noEmbedding ? 0x0002 : 0) | (raw.viewOnly ? 0x0004 : 0) | (raw.editable ? 0x0008 : 0);
}

/** フォントのバイト列から、補うための情報を作る。読めなければ undefined */
export async function createLocalFont(bytes: Uint8Array, postscriptName: string): Promise<LocalFont | undefined> {
  const { default: fontkit } = await import('@cantoo/fontkit');
  let face: FontkitFace | null = null;
  let isCollection = false;
  try {
    // コレクション(TTC。例: MS 明朝)は名前で 1 書体を選び、単体のフォントはそのまま使う
    const opened = fontkit.create(bytes) as unknown as (FontkitFace & { type: string }) | { type: string; getFont(name: string): FontkitFace | null };
    isCollection = opened.type === 'TTC' || opened.type === 'DFont';
    face = isCollection ? (opened as { getFont(name: string): FontkitFace | null }).getFont(postscriptName) : (opened as FontkitFace);
  } catch {
    return undefined;
  }
  if (!face) return undefined;
  const f = face;
  return {
    name: f.fullName ?? postscriptName,
    postscriptName,
    bytes,
    isCollection,
    permission: permissionOf(fsTypeOf(f)),
    hasChar: (c) => f.hasGlyphForCodePoint(c.codePointAt(0)!),
    widthOf: (c) => ((f.glyphForCodePoint(c.codePointAt(0)!)?.advanceWidth ?? 0) * 1000) / f.unitsPerEm,
  };
}

interface FontDataLike {
  readonly postscriptName: string;
  readonly fullName: string;
  blob(): Promise<Blob>;
}

/**
 * PC のフォントから、名前が一致するものを探す。キーは normalizeFontName した名前。
 * ブラウザの許可ダイアログが出るため、ボタンを押したときの処理の最初に呼ぶこと
 */
export async function findPcFonts(wanted: readonly string[]): Promise<Map<string, LocalFont>> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<FontDataLike[]> }).queryLocalFonts;
  if (!query) throw new ReasonError('UNSUPPORTED_BROWSER_FEATURE', 'PC のフォントの読み取り');
  let all: FontDataLike[];
  try {
    all = await query.call(window);
  } catch {
    throw new ReasonError('LOCAL_FONTS_DENIED');
  }
  const want = new Set(wanted.map(normalizeFontName));
  const result = new Map<string, LocalFont>();
  for (const data of all) {
    const key = [data.postscriptName, data.fullName].map(normalizeFontName).find((k) => want.has(k));
    if (!key || result.has(key)) continue;
    const bytes = new Uint8Array(await (await data.blob()).arrayBuffer());
    const font = await createLocalFont(bytes, data.postscriptName);
    if (font) result.set(key, font);
  }
  return result;
}

export function supportsPcFonts(): boolean {
  return typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function';
}
