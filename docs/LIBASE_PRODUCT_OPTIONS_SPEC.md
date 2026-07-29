# LIBASE Product Options — 開発仕様書 v1.0

最終更新: 2026-07-25  
対象: LIBASE専用 Shopifyカスタムアプリ  
アプリ名: LIBASE Product Options

## 1. 目的

Easify Product Optionsを置き換え、LIBASEの商品オプションをShopify管理画面から編集できるようにする。

主な目的:

- 新商品追加時にLiquidコードを編集しない
- Easifyからエクスポートした24オプションセットを移行する
- 刻印、カラー、フォント、ラッピングなどを管理画面から設定する
- 有料オプションを決済金額へ反映する
- 選択内容をカートおよび注文管理画面へ保存する
- Gift the Momentで商品選択、価格反映、在庫連動、商品別刻印を実現する

## 2. 現在の開発状況

完了済み:

- Shopify CLI 4.5.2
- React Router版Shopifyアプリ作成
- アプリ名: LIBASE Product Options
- Theme App Extension作成
- SQLite + Prisma導入
- 商品権限設定:
  - read_products
  - write_products
- Prismaマイグレーション完了
- Easify CSV取得済み

プロジェクトパス:

```text
~/Desktop/libase-product-options
```

主要構成:

```text
app/
  db.server.ts
  shopify.server.ts
  routes/
prisma/
  schema.prisma
extensions/
  libase-product-options-theme/
```

## 3. Easify CSVの確認結果

ファイル:

```text
easify-product-options-option-sets-2026-07-25.csv
```

概要:

- 788行
- 63列
- 24オプションセット

オプションタイプ:

- dropdown: 359行
- product-list: 313行
- checkbox: 75行
- text-box: 34行
- file-upload: 7行

移行対象には以下が含まれる:

- 必須・任意
- 選択肢
- 初期値
- ヘルプ文
- プレースホルダー
- 追加料金
- 条件分岐
- 商品との紐付け
- 商品選択型オプション
- ファイルアップロード
- 画像・カラー関連情報

24セットの例:

- Organic Pebble Necklace Set
- Link Knot Necklace Set
- Linked Circle Necklace Set
- Gift the Moment
- Gleam Line Ring Set
- ギフトラッピング
- ショッパー
- LEDジュエリーボックス
- 写真彫刻ネックレス
- 水彩風アート

## 4. アーキテクチャ

```text
Shopify埋め込み管理画面
        ↓
Prisma / Database
        ↓
商品ごとの設定JSONをShopifyメタフィールドへ同期
        ↓
Theme App Extensionが商品ページで設定を読み込む
        ↓
入力内容をline item propertiesとしてカートへ送る
        ↓
注文管理画面に選択内容を表示
```

管理画面用DBはアプリ側に保持し、商品ページ表示用の公開設定は商品メタフィールドへ同期する。

推奨メタフィールド:

```text
namespace: libase_options
key: configuration
type: json
```

## 5. 管理画面の機能

### 5.1 オプションセット一覧

表示項目:

- セット名
- ステータス
- 対象商品数
- 項目数
- 最終更新日時
- CSV由来 / 手動作成

操作:

- 新規作成
- 編集
- 複製
- 削除
- 有効化・無効化
- 商品への割り当て
- CSVインポート
- CSVエクスポート

### 5.2 オプションセット編集

項目ごとに編集可能:

- 入力タイプ
- 表示ラベル
- 管理用名称
- 必須・任意
- プレースホルダー
- ヘルプ文
- 最小・最大文字数
- 選択肢
- 初期値
- 並び順
- 条件分岐
- 追加料金
- Shopify商品・バリエーションとの紐付け
- 刻印対応の有無
- 画像・カラースウォッチ

最初の対応タイプ:

- text-box
- dropdown
- checkbox
- product-list
- file-upload

## 6. 商品ページの要件

- 商品に紐づくオプションセットを自動表示
- 必須項目の未入力を防止
- 文字数制限
- 条件分岐による表示・非表示
- 選択内容を商品ごとのline item propertiesへ保存
- カートでも選択内容を表示
- 注文管理画面でも選択内容を表示
- モバイル最適化
- 複数の商品フォームがある場合も重複IDを発生させない
- 動的チェックアウトは有料オプションおよびバンドル完成まで無効化

## 7. 有料オプション

基本方針:

- 表示上だけ価格を加算しない
- Shopify上の実商品または実バリエーションを追加料金用としてカートへ追加する
- 管理画面で選択肢と追加料金用バリエーションIDを紐付ける

例:

```text
ショッパーあり
→ ショッパー追加 200円のバリエーションを同時追加
```

要件:

- メイン商品と追加料金商品を同時にカートへ追加
- 共通グループIDを付与
- メイン商品削除時に追加料金商品も連動削除
- 数量変更時の整合性を維持
- 注文管理画面で関連を判別可能にする

内部プロパティ例:

```text
_libase_group_id
_libase_parent
_libase_option_key
```

先頭がアンダースコアのプロパティは購入者向け表示から隠す想定。

## 8. Gift the Moment

Gift the Momentは通常オプションではなく、専用のバンドルビルダーとして実装する。

### 必須機能

- 候補商品・バリエーションを管理画面から設定
- Shopifyの商品価格をリアルタイム参照
- Shopifyの販売可否・在庫を参照
- 売り切れ商品を選択不可
- 選択した実商品を複数同時にカートへ追加
- 選択商品ごとに刻印入力を保持
- 商品ごとにカラー、サイズ、フォントを保持
- 同じセットの商品に共通セットIDを付与
- セット商品の片方だけを消せないよう制御
- 返金・在庫減算は実商品の明細単位で行える

例:

```text
Cross Necklace / Silver
  Gift the Moment: 1つ目
  刻印文字: Kento
  フォント: Pinyon Script
  _libase_bundle_id: GTM-xxxx

Organic Pebble / Gold
  Gift the Moment: 2つ目
  刻印文字: Yui
  フォント: Optima
  _libase_bundle_id: GTM-xxxx
```

## 9. Prismaモデル

現状追加済み:

- OptionSet
- OptionField
- OptionChoice
- OptionCondition
- ProductMapping
- ImportJob
- Session

重要方針:

- Shopify IDは文字列で保存
- 金額は円単位の整数で保存
- Easify固有IDを保持し、再インポート時にupsert可能にする
- 不明なCSV列はsettingsJsonへ保持し、データを捨てない
- 取り込み処理はトランザクション化する

## 10. CSVインポート

### 処理フロー

1. CSVをアップロード
2. 文字コードとヘッダーを検証
3. option_set_id単位にグループ化
4. option_id_unique単位に項目を作成
5. option_value_id単位に選択肢を作成
6. 条件分岐を解析
7. 商品紐付けを解析
8. 既存Easify IDと照合してupsert
9. ImportJobへ結果を保存
10. 管理画面でインポート結果を確認

### 必須ルール

- 元CSVの63列を可能な限り保持する
- 未対応列を黙って破棄しない
- 解析できない行はスキップ理由を記録する
- 同じCSVを再投入しても重複を作らない
- インポート前にプレビューを表示する
- 本登録前に24セット・行数・警告数を表示する

## 11. Theme App Extension

現在のサンプル:

```text
blocks/star_rating.liquid
snippets/stars.liquid
assets/thumbs-up.png
```

これらは後で削除し、以下へ置き換える:

```text
blocks/product_options.liquid
assets/libase-options.js
assets/libase-options.css
snippets/option-field.liquid
```

アプリブロックは商品テンプレートへ追加可能にする。

ブロック要件:

- 商品メタフィールドのJSONを読み込む
- 各フィールドを描画
- Shopify商品フォームへ入力値を結合
- AJAX Cart APIを使用できる
- 有料オプションおよびGift the Momentでは複数商品を一括追加
- エラーを購入者へ日本語表示

## 12. 実装優先順位

### Phase 1: 管理基盤

- オプションセット一覧
- Easify CSVアップロード
- CSVプレビュー
- DBインポート
- 24セット一覧表示
- セット詳細閲覧

### Phase 2: 通常オプション

- text-box
- dropdown
- checkbox
- 必須チェック
- line item properties
- 商品割り当て
- 商品メタフィールド同期
- Theme App Extension表示

### Phase 3: 有料オプション

- linkedVariantId管理
- 複数商品同時カート追加
- グループ削除・数量連動
- 注文テスト

### Phase 4: Gift the Moment

- product-list
- 価格・在庫参照
- 商品別刻印
- バンドルID
- カート制御
- 注文管理確認

### Phase 5: 高度な機能

- file-upload
- 画像プレビュー
- 複雑な条件分岐
- 並び替え
- 複製
- CSVエクスポート
- バックアップ
- 本番移行

## 13. 安全要件

- 本番LIBASEへは完成・テスト後に導入
- 開発ストアでテストする
- Easifyは移行完了まで削除しない
- 現在の固定Liquidコードもアプリ表示確認まで残す
- npm audit fix --forceは実行しない
- Prisma 7へのメジャーアップデートは開発中に行わない
- CSV原本を変更しない
- インポート処理にはロールバック手段を用意する

## 14. 完了条件

以下をすべて満たした時点でEasifyから切り替える:

- 24セットが管理画面に読み込まれている
- 通常商品で選択内容が注文管理画面に表示される
- 必須項目が機能する
- 有料オプションが決済額へ反映される
- 在庫が正しく減る
- Gift the Momentの商品選択と商品別刻印が動く
- カート削除・数量変更でもセットが壊れない
- スマホ表示が正常
- テスト注文が成功
- 本番テーマでアプリブロックが正常動作
