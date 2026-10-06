// ExtGState(gs)のうち、透明に関わる値を読む。効果の焼き込みとページ内の編集で使う。
import { PDFArray, PDFDict, PDFName, PDFNumber } from '@cantoo/pdf-lib';

/** ExtGState の、透明に関わる値(指定がない項目は undefined) */
export interface GsInfo {
  readonly fillAlpha?: number;
  readonly strokeAlpha?: number;
  /** ソフトマスクを設定する(true)/ 解除する(false) */
  readonly softMask?: boolean;
  /** Normal / Compatible 以外の描画モードを設定する(true)/ Normal に戻す(false) */
  readonly blend?: boolean;
}

/** 資源(Resources)の ExtGState 辞書から、名前 → 透明の値 を読む関数を作る */
export function extGStateReader(resources: PDFDict | undefined): (name: string) => GsInfo | undefined {
  const dict = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  return (name) => {
    const gs = dict?.lookupMaybe(PDFName.of(name), PDFDict);
    if (!gs) return undefined;
    const number = (key: string) => {
      const v = gs.lookup(PDFName.of(key));
      return v instanceof PDFNumber ? v.asNumber() : undefined;
    };
    const smask = gs.lookup(PDFName.of('SMask'));
    const bm = gs.lookup(PDFName.of('BM'));
    const mode = bm instanceof PDFArray ? bm.lookup(0) : bm;
    return {
      fillAlpha: number('ca'),
      strokeAlpha: number('CA'),
      softMask: smask === undefined ? undefined : smask instanceof PDFDict,
      blend: mode instanceof PDFName ? !['Normal', 'Compatible'].includes(mode.decodeText()) : undefined,
    };
  };
}
