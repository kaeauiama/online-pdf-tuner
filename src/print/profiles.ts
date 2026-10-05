// 印刷所プロファイル(D-009: 非公式の目安。出典と確認日を必ず付ける)。
// 入稿チェックの閾値はここが単一ソース。ドキュメントからは名前で参照する。
// 値の根拠: docs/research/2026-10-print-shop-guides.md(2026-10-06 に原文で再確認した数値は sources の quote に記載)

export interface ProfileSource {
  readonly url: string;
  /** 原文の引用(短く) */
  readonly quote: string;
}

export interface PrintProfile {
  readonly id: string;
  readonly label: string;
  /** 塗り足し(各辺、mm) */
  readonly bleedMm: number;
  /** 安全領域: 文字などを仕上がり線からこれ以上内側に置く(mm) */
  readonly safeMarginMm: number;
  /** 推奨解像度(ppi)。これ未満は INFO */
  readonly recommendedDpi: number;
  /** 出典がなく汎用値で埋めた項目の説明 */
  readonly assumptions: readonly string[];
  /** 自動では確認できない、この印刷所ならではの注意(手動チェックリスト) */
  readonly manualChecks: readonly string[];
  readonly sources: readonly ProfileSource[];
  /** 出典を確認した日 */
  readonly checkedOn: string;
}

export const PROFILES: readonly PrintProfile[] = [
  {
    id: 'generic',
    label: '汎用(各社共通の目安)',
    bleedMm: 3,
    safeMarginMm: 5,
    recommendedDpi: 300,
    assumptions: ['安全領域は、各社の値(3〜5mm)のうち厳しい側の 5mm にしています。'],
    manualChecks: ['入稿前に、注文する印刷所の最新の入稿ガイドを確認してください。'],
    sources: [],
    checkedOn: '2026-10-06',
  },
  {
    id: 'tcpc',
    label: '東京カラー印刷(非公式)',
    bleedMm: 3,
    safeMarginMm: 3,
    recommendedDpi: 350,
    assumptions: [
      'Office で作った PDF の場合、ページを「仕上がりサイズ」と「塗り足し込みのサイズ」のどちらで作るべきかは公式ページに明記がありません。注文時に確認してください。',
    ],
    manualChecks: [
      '線は 0.25pt 以上にしてください(細い線はかすれる原因になります)。',
      'セキュリティ(パスワード・編集制限)を設定した PDF は入稿できません。',
      'Office で作った PDF は RGB のため、印刷時に CMYK に変換され色味が変わることがあります(了承のうえで進行)。',
      '中綴じの冊子は、表紙を含めて 4 の倍数のページ数にしてください。',
    ],
    sources: [
      { url: 'https://www.tcpc.co.jp/links/makeInfo', quote: '天地左右に3mmずつ作成します' },
      { url: 'https://www.tcpc.co.jp/links/makeInfo', quote: '欠けてはいけない文字・絵柄は仕上りの内側3mm以内に納めて下さい' },
      { url: 'https://www.tcpc.co.jp/links/makeInfo', quote: '解像度は300～400pixcel/inchiで作成ください' },
      { url: 'https://www.tcpc.co.jp/links/makeInfo', quote: '0.25pt以上の線を設定くださいませ' },
    ],
    checkedOn: '2026-10-06',
  },
  {
    id: 'kinkos',
    label: 'キンコーズ(非公式)',
    bleedMm: 3,
    safeMarginMm: 5,
    recommendedDpi: 300,
    assumptions: [
      '出典は三宮店の資料です。店舗によって異なる可能性があります。',
      '解像度の推奨値は資料に記載がないため、汎用値(300ppi)にしています。',
    ],
    manualChecks: [
      'トンボを付けられない場合は、塗り足し込みのサイズ(例: A4 なら 216×303mm)で作れば入稿できます。',
      '入稿の際は、元データ(Word / PowerPoint など)と PDF の両方を持参すると安心です。',
    ],
    sources: [
      {
        url: 'https://www.kinkos.co.jp/wp-content/uploads/2025/01/%E3%80%90%E4%B8%89%E5%AE%AE%E3%80%91%E3%83%95%E3%83%81%E3%81%AA%E3%81%97%E5%8D%B0%E5%88%B7_%E3%83%87%E3%83%BC%E3%82%BF%E4%BD%9C%E6%88%90%E6%99%82%E3%81%AE%E6%B3%A8%E6%84%8F%E7%82%B9.pdf',
        quote: '裁ち落としラインより内側5ｍｍの範囲内…には、重要な文字を表記したり、デザインを載せたりしない',
      },
    ],
    checkedOn: '2026-10-06',
  },
  {
    id: 'accea',
    label: 'アクセア(非公式)',
    bleedMm: 3,
    safeMarginMm: 5,
    recommendedDpi: 300,
    assumptions: ['安全領域は公式の「4〜5mm以上内側」のうち 5mm にしています。'],
    manualChecks: [
      'フチなしで仕上げる場合は、注文時の入稿情報「印刷内容」の欄にその旨を書いてください。',
      '塗り足しがないデータは、上下左右に 4〜5mm 程度の白い枠が出ます。',
      'Word / PowerPoint で特殊なフォントを使うと、別のフォントに置き換わる可能性があります(PDF に埋め込めば防げます)。',
    ],
    sources: [
      { url: 'https://www.accea.co.jp/usersguide/uploaddata.html', quote: '3mm以上はみ出すように画像を作成してください' },
      { url: 'https://www.accea.co.jp/usersguide/uploaddata.html', quote: '4〜5mm以上内側に配置してください' },
      { url: 'https://www.accea.co.jp/usersguide/uploaddata.html', quote: 'A3以下のカラー出力の場合は300dpi程度必要です' },
    ],
    checkedOn: '2026-10-06',
  },
];

export function findProfile(id: string): PrintProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}
