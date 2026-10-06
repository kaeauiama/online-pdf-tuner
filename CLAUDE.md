# pwa_pdf

自分で管理する、ブラウザ内で完結するPDFツール。GitHub Pages で静的サイト / PWA として配信する。
他人のオンラインPDFサイトへの不信が出発点なので、機能の多さより**信頼を検証できること**を最優先する。
差別化の柱は**日本の印刷所への入稿に向けたチェックと修正**(塗り足し・トンボ・入稿前チェック)。

## ドキュメントの優先順位

1. `docs/spec/` — 正式仕様(矛盾したらこちらを正とする)
2. `docs/decision-log.md` — 決定の経緯・UNDECIDED・暫定値
3. `docs/research/` — 調査メモ(参考。仕様やコードに取り込んだ時点で SUPERSEDED と明記する)

閾値・定数(塗り足し量、安全領域、印刷所プロファイル等)は実装後**コード側の単一箇所**を正とし、
ドキュメントからは名前で参照する。数値をプローズに重複させない。

## Hard Constraints(恒久的に越えない一線)

詳細と根拠は `docs/spec/01-scope.md`。いずれも「ガード + 回帰テスト」で担保する。

- **HC-1** PDFの内容を外部へ送信しない
- **HC-2** 実行時に外部オリジンからコード・WASM・フォントを読み込まない(すべて同梱)
- **HC-3** アクセス解析・トラッキングを入れない
- **HC-4** パスワードを知らない暗号化PDFの解除・権限制限の回避をしない

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー(CSP なし。HMR のため) |
| `npm run build` | 型チェック → ビルド → `scripts/verify-dist.mjs`(CSP と外部読み込みの検査) |
| `npm test` | 単体テスト(Vitest) |
| `npm run test:e2e` | ビルドして E2E テスト(Playwright。インストール済みの Edge を使う) |
| `node scripts/make-sample-pdfs.mjs <dir>` | 手動確認用のサンプル PDF を作る |

## コードの構成

- `src/core/` — PDF 処理の純粋関数(ページの並び、範囲の解釈、書き出し)。UI に依存しない
- `src/core/pdfLoad.ts` — PDF を編集用に読み込む唯一の入口(HC-4 のガード)
- `src/security/csp.ts` — CSP の単一ソース(HC-1/2/3 のガード)
- `src/render/pdfjs.ts` — pdf.js による描画。ワーカーは blob: 経由で生成して CSP を継承させる
- `src/pdf/lexer.ts` — コンテンツストリームの解析器(入稿チェックと誤植修正で使う)
- `src/print/` — 入稿チェック。`profiles.ts`(印刷所ごとの値)と `thresholds.ts`(共通の閾値)が単一ソース
- `src/typo/` — 誤植修正(S1・試験的)。フォントの許諾(fsType)の確認は `src/pdf/fonts.ts`
- `src/app/` — 画面と操作(`app.ts` が編集画面、`checkView.ts` が入稿チェック画面、`typoDialog.ts` が誤植修正)
- `src/sw/sw-template.js` — サービスワーカー(M4)。ビルド時に `vite.config.ts` が `dist/sw.js` を書き出す
- `src/app/pwa.ts` — サービスワーカーの登録・更新の通知・ファイルハンドラ・インストール
- `public/fonts/` — 文字入れ用の日本語フォント(BIZ UDPゴシック、OFL)。`scripts/build-fonts.py` で生成
- `scripts/inspect-pdf.mjs` — PDF の構造を調べる開発用ツール

## 進め方

- スコープ拡大・制約の例外は、ユーザーの明示承認を得てから行う。承認は日付つきで Decision Log に記録する。
- 未決定事項は勝手に埋めず、Decision Log の UNDECIDED に置く。
- 非対応は理由コードで明示する(沈黙の失敗や回避ハックはしない)。
- 処理ロジックは UI から切り離した純粋関数にし、テスト可能に保つ。
- 利用者の実ファイル(個人情報を含みうる)はリポジトリに入れない。テストは合成 PDF で行う(D-019)。
