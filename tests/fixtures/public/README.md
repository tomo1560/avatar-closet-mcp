# 公開データ fixture（未ログインで取得）

- 取得日: 2026-10-12（JST）
- 取得方法: Node.js 25 の global `fetch`、未ログイン、Cookie は `adult=t` のみ、Chrome 風 User-Agent、`redirect: "manual"`
- リクエスト: 合計 20 回（直列、1.6 秒以上の間隔）。`accounts.booth.pm` へのアクセスと商品ページ HTML の取得はしていない
- 加工: `search.html` の `<meta name="csrf-token">` の値だけ `REDACTED-FIXTURE` に置換。商品 JSON は整形（pretty-print）のみで内容は無加工

## ファイル

| ファイル | 取得元 |
| --- | --- |
| `search.html` | `GET https://booth.pm/ja/search/しなの%20衣装`（1 ページ目） |
| `autocomplete-tag.json` | `GET https://booth.pm/autocomplete/tag.json?term=しなの` |
| `items/{id}.json` | `GET https://booth.pm/ja/items/{id}.json`（14 件） |
| `compat-labels.json` | 上記 14 件に手で付けた正解ラベル（PLAN §3.5.2 の評価用） |

fixture に保存していないリクエスト: JSON 版検索の確認 2 回、`adult` Cookie なしでの検索 1 回、Quest 対応商品を探すための検索 `Quest対応 しなの 衣装` 1 回。

## 商品

| id | category | 内容 | 評価ポイント |
| --- | --- | --- | --- |
| 6106863 | 208 | アバター本体「しなの」 | `avatar_id` |
| 3681787 | 208 | アバター本体「桔梗」 | `avatar_id` |
| 6115428 | 208 | しなの専用ロリ化 Prefab + 表情 | category 208 だがアバター本体ではない |
| 5359699 | 209 | 15 アバター対応衣装（VAGRANT） | variations「和名 - English」、本体リンク一覧、tag `maya` は舞夜ではない |
| 4866933 | 209 | 10 アバター対応ビキニ | 商品名・variations・『対応アバター』見出し・tags がすべて一致、別商品（真冬/サリア用）への言及 |
| 4911160 | 209 | メイガスバニー | variations に 2〜3 体まとめ、tags にだけあるアバター名 |
| 7065708 | 209 | Hoodie set（23 アバター） | variations のみが根拠、誤記 `SEKESTIA` |
| 8831909 | 209 | Long Cape Coat（3 アバター + tag の PlusHead） | variations なし、『対応アバター』見出し、依存 lilToon / MA、依存ではない言及 |
| 6289322 | 209 | 【しなの対応】Vigilant Style | 単一アバター、description は見出しなしの文中表現 |
| 6659058 | 209 | Date knit【しなの用】 | Quest 対応が tags にだけある |
| 4904935 | 217 | Assault Hand（グローブ, 20 アバター） | 装飾品、MA は任意対応 |
| 6745224 | 230 | Simple_BoB（ヘア, 18 アバター） | 1 バリエーションに 2 体（`MameFriends (Kipfel / Mamehinata)`, `Nemesis_ELusion`） |
| 3087170 | 215 | lilToon | ツール、無料バリエーションの `downloadable` |
| 5737352 | 215 | 落ち影システム | MA ベースのアバターギミック |

## 分かったこと

### `items/{id}.json`

- トップレベルのキーは 34 個: `description, factory_description, id, is_adult, is_buyee_possible, is_end_of_sale, is_placeholder, is_sold_out, name, published_at, price, shipping_info, small_stock, url, wish_list_url, wish_lists_count, wished, purchase_limit, past_purchase_count, buyee_variations, category, embeds, images, order, gift, report_url, share, shop, sound, tags, tag_banners, tag_combination, tracks, variations`
- `price` は表示用の文字列（例 `"¥ 2,500~"`）。数値は `variations[].price`
- `category` は `{ id, name, parent: { name, url }, url }`（`parent` に id は無い）
- 未ログインでは `wished: false`, `order: null`, `gift: null`, `past_purchase_count: 0`、`variations[].order_url: null`, `variations[].past_purchase_count: 0`。14 件すべてでメールアドレス様の文字列なし
- 無料バリエーション（`status: "free_download"`）は未ログインでも `variations[].downloadable.no_musics[]` に `{ file_name, file_extension, file_size, name, url }` が入る。`url` は `https://booth.pm/downloadables/{id}?variation_id={variation_id}`。有料は `status: "addable_to_cart"`, `downloadable: null`
- 対応アバター別に売る商品の `variations[].name` は「しなの - Shinano」「しなの -Shinano-」「Shinano」「しなの・桔梗用（Shinano・Kikyo）」「桔梗用 - Kikyo」など書式がばらばら。単一バリエーションの商品は `name: null`
- `description` はプレーンテキスト。アバター本体（しなの・桔梗）は「必ず下記の商品説明と利用規約をお読み下さい」の 1 行だけだった。商品ページ本文の追加セクションは JSON に含まれていない可能性が高い（商品ページ HTML は方針により取得していないので未確認）

### カテゴリ ID（PLAN §3.5.5 / §7 項目 10）

`category.id` と、検索結果カードの `data-product-category` とカテゴリ名リンク（`.item-card__category-anchor`）の組で確認した。210 / 214 / 216 は `Quest対応 しなの 衣装` の検索結果ページで確認したもので、そのページは fixture に保存していない（下表の商品 ID で再確認できる）。

| id | 名前 | 確認元（商品 ID） |
| --- | --- | --- |
| 208 | 3Dキャラクター | items JSON（6106863, 3681787, 6115428）、`search.html` |
| 209 | 3D衣装 | items JSON（5359699 ほか）、`search.html` |
| 210 | 3D小道具 | 検索カードのみ（6181611, 7040240） |
| 214 | 3Dテクスチャ | 検索カードのみ（6569241, 6398460, 7329599） |
| 215 | 3Dツール・システム | items JSON（3087170, 5737352） |
| 216 | 3Dモーション・アニメーション | 検索カードのみ（4197129, 4519820, 4910748） |
| 217 | 3D装飾品 | items JSON（4904935）、`search.html` |
| 230 | 3D髪型 | items JSON（6745224）、`search.html` |

3D靴・3DCG・3D環境・ワールド・3Dモデル（その他）の ID は未確認。親カテゴリ「3Dモデル」の下にある名前は `3DCG・3DCG集 / 3Dキャラクター / 3D衣装 / 3D髪型 / 3D装飾品 / 3D靴 / 3D小道具 / 3Dテクスチャ / 3Dツール・システム / 3Dモーション・アニメーション / 3D環境・ワールド / 3Dモデル（その他）`。カテゴリ絞り込みのリンクは ID ではなく名前で指定する（`https://booth.pm/ja/browse/3D衣装?q=...`）。

### 検索結果 HTML（`search.html`）

- 1 ページ 60 件。カードは `li.item-card`。属性 `data-product-id`, `data-product-name`（長い名前は「...」で省略される）, `data-product-brand`（ショップのサブドメイン）, `data-product-category`（カテゴリ ID）, `data-product-price`（数値）, `data-product-event`
- 完全な商品名: `.item-card__title-anchor--multiline`（href `https://booth.pm/ja/items/{id}`）
- カテゴリ名: `.item-card__category-anchor`（href `https://booth.pm/ja/browse/{カテゴリ名}`）
- ショップ名: `.item-card__shop-name`、ショップ URL: `a.item-card__shop-name-anchor`
- 価格: `.price`（例 `¥ 1,700~`）
- サムネイル: `.item-card__thumbnail-image` の `data-original`（`booth.pximg.net`）
- バッジ: `.l-item-card-badge img[alt]`（例 `VRChat`）
- ページ送り: `.pager a.nav-item`、最終ページは `.pager a.nav-item.last-page`（href `...?page=159`）
- 総件数: 「しなの 衣装の通販・ダウンロード商品は9,535件あります。」という文（`p.u-tpg-caption1`）
- 右側のカテゴリ別件数: `via category_list to category_index` のリンク（例 `3D衣装(7,492)`）
- ページ内の `<meta name="js_const_*">`: `js_const_user_signed_in`（未ログインで `false`）、`js_const_user_adult`、`js_const_user_uuid`（未ログインで `null`）、`js_const_wish_lists_url`（`https://accounts.booth.pm/wish_lists.json`）

### JSON 版の検索（PLAN §7 項目 3）

無い。HTML をパースする前提で進める。

- `GET /ja/search/しなの%20衣装.json` → 200 `text/html`。`.json` まで検索語として扱われる（「しなの 衣装.json」で 12 件）
- `GET /ja/items.json?q=しなの%20衣装` → 302 で `https://booth.pm/ja/search/しなの%20衣装`（HTML）へ

### `autocomplete/tag.json`

文字列の配列（10 件、ID や件数は無い）。例: `["しなの", "shinano", "しなの face", ..., "しなの対応", "しなの用", "しなの専用", ...]`

### `adult=t` Cookie

この検索（全年齢）では無くても同じ結果だった。Cookie あり・なしで総件数 9,535 件、60 件の商品 ID と並び順が一致し、変わったのは `js_const_user_adult` の値（`true` / `false`）だけ。検索は既定で全年齢のみで、オプションバッジ `adult_all_age` を外すリンクが `?adult=include` になっている。R-18 商品（`is_adult: true`）の JSON と `adult=include` の検索で必要かは未確認。

## `compat-labels.json` のラベル規則

```json
{ "<item_id>": { "kind": "avatar|costume|accessory|tool|motion|other", "avatar_id": "(kind=avatar のときのみ)", "compatible": [], "not_supported": [], "dependencies": [], "quest_support": "yes|no|unknown", "must_not_match": [], "notes": "" } }
```

- `compatible`: 出品者がその商品を使えると示しているアバターの ID（小文字の英字）。対応アバター別にバリエーションを分けて売っている商品では、バリエーションがあるアバターだけを数える（tags にしか無い名前は数えない）。単一バリエーションの商品では、商品名・『対応アバター』見出し・本文・tags のどれかで出品者が対応と言っていれば数える（tags だけの主張は notes に書く）
- `kind: "avatar"` はアバター本体。`avatar_id` にそのアバターの ID を入れ、`compatible` は空にする（tags の自分の名前は自己言及であって対応表記ではない）。PLAN §3.5.3 で辞書を初期生成するときの正解に使う
- `kind` はカテゴリではなく中身で決める（6115428 は category 208 だが `other`）。3D髪型（230）は PLAN の kind に無いので `accessory` にした
- `not_supported`: 「〇〇は非対応」のような明示的な否定だけ。部分対応（「しなのは Breast_Flat のみ」）やバージョン制約（「ミルティナは 1.01.1 以前はサポート外」）は含めない
- `dependencies`: 必要、または対応している導入方法として書かれているシェーダー・ツール。値は `liltoon`, `poiyomi`, `uts`, `modular_avatar`, `vrcfury`, `avatar_optimizer`, `ndmf`, `faceemo`。「MA対応」も `modular_avatar` に含める。VRChat SDK の機能（PhysBone, Avatars 3.0）と、撮影にだけ使ったツールや使ってもよいと書かれているだけのツールは含めない
- `quest_support`: 商品データに Quest / Android 対応か PC 専用の記述があれば `yes` / `no`、無ければ `unknown`
- `must_not_match`: 商品データに出てくるが、対応アバターとして抽出してはいけない文字列（別商品への誘導、tags にしか無いアバター名、アバター名と紛らわしい語）。誤検出を数える評価用

### このデータセットに無いケース

- 明示的な非対応の記述（`not_supported`）の例
- `quest_support: "no"`（PC 専用）の例
- `kind: "motion"` の商品
