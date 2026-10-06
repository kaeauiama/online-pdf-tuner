// 入稿チェックの、印刷所によらない閾値。印刷所ごとの値は profiles.ts に置く。

/** これ未満の実効解像度(ppi)は「粗さが目立ちやすい」として WARN にする */
export const LOW_DPI_WARN = 150;

/** 解像度チェックの対象外にする小さな画像(Office が模様用に入れる 2×2 画像など) */
export const MIN_IMAGE_PIXELS = 16 * 16;
/**
 * 解像度チェックの対象外にする「平坦な画像」の圧縮率(元の画素データ ÷ 圧縮後の大きさ)。
 * 単色の塗りやなめらかなグラデーション(Office が図形の効果に使う)は極端によく圧縮され、
 * 解像度が低くても見た目に影響しない。写真の JPEG はおおむね 5〜30 倍程度。
 */
export const FLAT_IMAGE_COMPRESSION_RATIO = 64;
/** 解像度チェックの対象外にする、表示サイズが小さい画像(mm²)。アイコン程度の大きさ */
export const MIN_IMAGE_AREA_MM2 = 15 * 15;

/** 「塗り足し込みのサイズ」と判定する、片側の余白の範囲(mm) */
export const BLEED_DETECT_MIN_MM = 2;
export const BLEED_DETECT_MAX_MM = 6;

/** 端の色の判定: 辺の長さに対してこの割合以上で問題があれば指摘する */
export const EDGE_PROBLEM_RATIO = 0.01;
/** 端の色の判定: RGB のいずれかがこの値未満なら「色がある」とみなす(0〜255) */
export const INK_THRESHOLD = 240;
/** 端の色の判定に使う描画解像度(px/mm) */
export const EDGE_RENDER_PX_PER_MM = 4;

/** 文字の位置判定の許容誤差(pt) */
export const TEXT_TOLERANCE_PT = 0.5;

/** くすみ警告: 印刷で出せる彩度をこれ以上超える色を「くすみやすい」とする(C*ab) */
export const GAMUT_MODERATE_DELTA_C = 8;
/** くすみ警告: これ以上超える色を「大きくくすむ」とする */
export const GAMUT_STRONG_DELTA_C = 20;
/** くすみ警告: 仕上がり面積のうち、大きくくすむ色がこの割合以上なら WARN */
export const GAMUT_WARN_AREA_RATIO = 0.05;
/** くすみ警告: くすみやすい色がこの割合以上なら INFO(これ未満は指摘しない) */
export const GAMUT_INFO_AREA_RATIO = 0.005;

/** 細すぎる線: 実効の線幅がこれ未満(mm)なら、かすれたり消えたりしやすい。印刷所の多くは 0.1mm(約 0.3pt)以上を求める */
export const THIN_LINE_MM = 0.1;
/** 小さすぎる文字(pt、実際に描かれる大きさ) */
export const SMALL_TEXT_PT = 5;
/** リッチブラック(複数のインキで作った黒)の文字を指摘する、文字の大きさの上限(pt) */
export const RICH_BLACK_TEXT_MAX_PT = 12;
/** リッチブラックとみなす CMYK: K がこれ以上で… */
export const RICH_BLACK_MIN_K = 0.6;
/** …C + M + Y がこれ以上 */
export const RICH_BLACK_MIN_CMY = 0.15;
/** 総インキ量(C + M + Y + K、%)の上限。Japan Color 2011 Coated は 350%。300% を求める印刷所もある */
export const INK_LIMIT_PERCENT = 350;
/** 1 ページ・1 種類あたりに記録する指摘の場所の上限(多すぎる場合は打ち切る) */
export const MAX_NOTES_PER_KIND = 200;
