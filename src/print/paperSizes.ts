// 仕上がりサイズの候補(縦向きの寸法、mm)。
export interface PaperSize {
  readonly id: string;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export const PAPER_SIZES: readonly PaperSize[] = [
  { id: 'A3', label: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'A4', label: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'A5', label: 'A5', widthMm: 148, heightMm: 210 },
  { id: 'A6', label: 'A6', widthMm: 105, heightMm: 148 },
  { id: 'B4', label: 'B4', widthMm: 257, heightMm: 364 },
  { id: 'B5', label: 'B5', widthMm: 182, heightMm: 257 },
  { id: 'B6', label: 'B6', widthMm: 128, heightMm: 182 },
  { id: 'postcard', label: 'はがき', widthMm: 100, heightMm: 148 },
  { id: 'card', label: '名刺', widthMm: 55, heightMm: 91 },
];

/** サイズ比較の許容誤差(mm)。Office の出力は 0.1mm 単位で丸められることがある */
export const SIZE_TOLERANCE_MM = 1;

export function findPaperSize(id: string): PaperSize | undefined {
  return PAPER_SIZES.find((p) => p.id === id);
}

export function formatSize(widthMm: number, heightMm: number): string {
  const f = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
  return `${f(widthMm)}×${f(heightMm)}mm`;
}
