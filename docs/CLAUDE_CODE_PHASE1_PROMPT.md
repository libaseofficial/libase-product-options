# Claude Code 実装開始プロンプト

あなたは `~/Desktop/libase-product-options` にあるShopify React Routerアプリを実装します。

最初に以下を実行してください。

1. プロジェクト全体を読み取る
2. `docs/LIBASE_PRODUCT_OPTIONS_SPEC.md` を読む
3. 現在のPrisma schema、routes、Shopify設定、Theme App Extensionを確認する
4. 既存コードを壊さず、Phase 1だけを実装する
5. 実装前に短い作業計画を提示する
6. 実装後に変更ファイル一覧、実行コマンド、確認手順を提示する

今回実装するPhase 1:

- オプションセット一覧画面
- Easify CSVアップロード画面
- CSVのヘッダー検証
- インポート前プレビュー
- option_set_id単位の集計
- Prisma DBへのupsert
- ImportJobへの結果保存
- インポート後に24セットを一覧表示
- セット詳細ページで項目と選択肢を閲覧

重要:

- TypeScriptを使用する
- Shopify公式React Routerテンプレートの構造を維持する
- Prisma 6.19.3を維持する
- SQLiteを開発用として維持する
- 既存のSessionモデルを壊さない
- CSVの未知の列はsettingsJsonへ保存し、破棄しない
- 同じCSVを再インポートしても重複しないようupsertする
- いきなり全Phaseを実装しない
- Gift the Moment、有料オプション、Theme App Extension描画は今回まだ実装しない
- `npm audit fix --force`を実行しない
- 変更前に必要ならバックアップを作る
- TypeScript、Prisma、ビルドのチェックを行う
