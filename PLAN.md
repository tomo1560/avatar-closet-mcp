# booth-mcp 作成プラン（購入者向け BOOTH MCP + CLI）

調査日: 2026-10-12（同日 VRChat 購入者向け機能を追記: §0.1, §3.5, Phase 2.5）/ ステータス: **Phase 0〜5 実装済み・ログインした実アカウントで検証済み（2026-10-12、ブランチ `feat/buyer-mcp`）。ほかに、ほしいものリストと無料ダウンロードも実装済み（もとは §9.3 で見送っていたもの）。パッケージ名は `avatar-closet-mcp` に変更（§7-7）**

---

## 0. 結論サマリ

既存ツールを「出品者側 / 購入者側 / 公開データ」×「MCP / CLI・SDK」で整理すると以下の通り。

| 用途 | MCP | CLI / SDK / その他 |
|---|---|---|
| **出品者側 read**（ダッシュボード・注文・売上・メッセージ） | ✅ [cstria0106/booth-mcp](https://github.com/cstria0106/booth-mcp)（npm `booth-mcp` 0.2.2, MIT, ブラウザログイン, 読み取り専用） | — |
| **出品者側 write**（商品説明・価格・画像・DLファイル差し替え） | ✅ [quolu/booth-mcp](https://github.com/quolu/booth-mcp)（MIT, Chrome拡張でcookie同期, Windows前提, 3 commits） | — |
| **購入者側**（ライブラリ・ギフト・注文履歴・購入品DL） | ❌ **存在しない** | [Myrkie/BoothDownloader](https://github.com/Myrkie/BoothDownloader)（C#, Windows, 44★, DL特化）／ [tukiminya/omnooth](https://github.com/tukiminya/omnooth)（Go, 実験段階・「ほぼ正しく動作しない」と明記）／ユーザースクリプト・ブラウザ拡張多数 |
| **公開データ**（検索・商品詳細・タグ補完） | △ [Kyure-A/mcp-booth](https://github.com/Kyure-A/mcp-booth)（`search_by_keyword` 1本のみ, 正規表現でHTMLパース, GPL-3.0, README無し） | [booth-pm-sdk](https://github.com/thisoverride/BoothPM-SDK)（TS, MIT, 検索/商品詳細, pixivログイン可。ただしウィッシュリストはローカルJSONで本物のBOOTHと非連携） |

**前提（仮定）**: Unity/VRChat アセット購入者としての利用を想定し、本プランは空白地帯である **「購入者側 MCP（+同じコアを使う CLI）」** を対象とする。
→ もし出品者側が目的なら **cstria0106/booth-mcp をそのまま導入すれば足りる**（このプランは不要）。

### 0.1 VRChat 購入者向けの既存ツール（GUI のみ・MCP は無し）

| ツール | BOOTH 連携 | VRChat 向け機能 | CLI/API | 形態 |
|---|---|---|---|---|
| [Hoard](https://github.com/Soloflighter1010/Hoard-Asset-Manager)（MIT, Python） | ✅ ブラウザログイン（トークンは OS で暗号化）、購入一覧取得・DL | 更新検知と旧版保持、Unity プロジェクトに導入済みかの表示、lilToon/MA などの依存表示、VCC 経由の Unity 拡張 | △ `hoard-cli login/refresh/sync`。一覧表示や JSON 出力のコマンドは見当たらない | Win/Mac/Linux |
| [KonoAsset](https://github.com/siloneco/KonoAsset)（MIT, Tauri, 101★） | △ 商品情報の取得 | アバター本体・アバター用アセット・ワールド用アセットに分類、zip 自動展開 | ❌ | Windows |
| [VRC-Avatar-Explorer](https://github.com/puk06/VRC-Avatar-Explorer)（AGPL-3.0, C#） | △ 商品情報の自動取得 | 対応アバターを手動で紐付け、unitypackage の一括インポート | △ UI に依存しない Core ライブラリはあるが CLI は無い | Win/Mac/Linux |
| [BOOTH Package Linker](https://booth.pm/ja/items/8639617)（¥500, 非公開） | ✅ ライブラリとギフトを一括取得 | 購入品の更新通知、ウィッシュリスト商品の値下げ通知、Unity へ直接送る | ❌ | Windows |
| [VRCFinder](https://uhiyama-lab.com/en/product/vrcfinder/)（Web） | 公開商品のみ | 説明文の解析と手動キュレーションによる**対応アバター検索**（2022年以降・500いいね以上の商品のみ） | ❌ API 無し | Web |

**空白地帯**: 「持ってる衣装のうちしなの対応はどれ？」「この商品は自分のアバターに対応してる？」に **Claude から答えられる手段が無い**。→ §3.5 で対応する。

---

## 1. 方針: cstria0106/booth-mcp をフォークして購入者機能を追加

### 1.1 なぜフォークか（ソース確認済み）

cstria0106/booth-mcp (MIT) の `src/` を確認した結果、再利用価値が高い:

| 部品 | 実装 | 再利用可否 |
|---|---|---|
| ログイン | `playwright-core` の `chromium.launchPersistentContext(profileDir)` + システムの Chrome/Edge (`channel: "chrome" / "msedge"`)、`headless: false`、ユーザーが手動ログイン（パスワードを扱わない） | ◎ 汎用。ただしログイン先 `https://manage.booth.pm/` と成功判定（`/orders` リンク有無）が出品者専用 → **差し替え必要** |
| セッション保存 | `context.storageState()` を取得後、cookie と localStorage origin を `isBoothHost`（`booth.pm` / `*.booth.pm`）で**ドメインフィルタ**して session.json に保存（pixiv.net の cookie は除外）。ファイル `0o600`、ディレクトリ `0o700` | ◎ そのまま。ただし**ログイン用の永続ブラウザ profile dir 側には pixiv の cookie も残る**ので、ログアウト時に profile dir ごと削除する。Windows では `chmod` が NTFS ACL に効かない点に注意 |
| HTTP クライアント | Playwright `APIRequestContext`、直列キュー、`MIN_REQUEST_INTERVAL_MS = 1000`、30秒タイムアウト、手動リダイレクト（最大5回、**別ホストへ飛んだら AUTH_REQUIRED**） | ○ origin を `accounts.booth.pm` / `booth.pm` に広げる。DL の署名付き URL リダイレクトだけ例外処理が必要 |
| 読み取り専用ガード | `*.booth.pm` へは `GET/HEAD/OPTIONS` のみ許可 | ◎ そのまま（購入者 v1 も read-only） |
| エラー体系 | `AUTH_REQUIRED / NOT_FOUND / BOOTH_CHANGED / RATE_LIMITED / NETWORK_ERROR` | ◎ そのまま。429 時のリトライ/バックオフは**無い**ので追加 |
| テスト | vitest + HTML fixture + `BOOTH_MCP_LIVE=1` で live テスト | ◎ 同じ流儀で購入者ページの fixture を追加 |
| 配布 | bun build → npm、Codex plugin 定義、`skills/booth/SKILL.md` | ○ パッケージ名は要変更（下記） |

代替案（フォールバック）: フォークが合わなくなった場合は新規 TS プロジェクトにし、認証は `booth-pm-sdk` の `login()`（puppeteer で pixiv OAuth → booth.pm cookie を `~/.booth-pm-sdk/session.json` に保存）を流用する。

### 1.2 フォーク時の注意

- **npm 名 `booth-mcp` は使用済み**（cstria0106）。例: `@<scope>/booth-mcp` や `booth-library-mcp` などに変更。
  → 最終的なパッケージ名は **`avatar-closet-mcp`**。`booth-library-mcp` は公式アプリ「BOOTH Library Manager」と紛らわしく、pixiv の登録商標ガイドラインの「当社サービスと混同を招きかねない名称は避けてください」に当たるため改名した（§7-7、docs/research-2026-10-12.md §2）
- MIT のライセンス表記・原作者クレジットを保持。
- 上流が「出品者ダッシュボード専用」を明確にしているため、上流への PR は「認証部分の汎用化」程度に留め、購入者機能はフォーク側で持つのが無難（PR するかは任意）。
- 上流の README/メッセージは韓国語 → 日本語化。

### 1.3 スタックは Node/TS 固定（理由あり）

quolu/booth-mcp の README によると、BOOTH 側の Cloudflare が **Python の httpx / requests を TLS フィンガープリントで 403** にし、Node の fetch は通る。cstria0106 は Playwright の request context で実績あり。→ Python 実装は避ける。

---

## 2. BOOTH 側の判明済み仕様（実装者向けメモ）

> ⚠ HTML 構造は非公式・無告知で変わる。下記セレクタは BoothDownloader のソース由来で、**現行ページで要再確認**。

### 2.1 セッション

- セッション cookie: **`_plaza_session_nktz7u`**（domain `.booth.pm`, path `/`）— BoothDownloader で確認
- 年齢確認: cookie **`adult=t`** を付けないと年齢確認ウォールで一覧取得が失敗する（booth-pm-sdk は年齢確認ウォールで throw する）
- 有効性チェック: `GET https://accounts.booth.pm/settings` → 200 かつ最終 URL が `accounts.booth.pm/settings` のまま（BoothDownloader 方式）。未ログインなら `booth.pm/users/sign_in` 等へリダイレクトされる
- cookie はリクエストごとに更新され得る → **レスポンス後に storageState を書き戻す**（cstria0106 は実装済み）
- ログインは pixiv OAuth（`https://booth.pm/users/sign_in` → `form[action="/users/auth/pixiv"]`）。reCAPTCHA/2FA があるので**自動ログイン（ID/パスワード投入）はやらない**。必ずユーザーが実ブラウザで操作

### 2.2 公開データ（ログイン不要）

| データ | エンドポイント | 形式 |
|---|---|---|
| 商品詳細 | `https://booth.pm/ja/items/{id}.json` | **JSON**（34キー確認済: `id, name, price, description, is_adult, shop{uuid,name,subdomain,url,verified}, category{id,name,parent}, images[{original,resized}], tags[{name,url}], variations[{id,type,price,status,downloadable,...}], wished, wish_lists_count, order, gift, published_at ...`） |
| タグ補完 | `https://booth.pm/autocomplete/tag.json?term={q}` | JSON |
| 検索 | `https://booth.pm/ja/search/{q}` または `https://booth.pm/ja/items?...`／カテゴリは `browse/{category}`（`page`, `sort`, `max_price`, `adult` パラメータ） | HTML（cheerio でパース） |

→ 商品ページ HTML のスクレイピングは**禁止**し、必ず `.json` を使う。

### 2.3 購入者データ（ログイン必須）

| データ | URL | 抽出方法（BoothDownloader 由来・要再確認） |
|---|---|---|
| ライブラリ | `https://accounts.booth.pm/library?page=N` | 商品ID: `a[href]` を `booth\.pm(?:\/\w+)?\/items\/(\d+)` でマッチ／最終ページ: `//a[@class='nav-item last-page']` の href の `page=` 以降／サムネ: `img.l-library-item-thumbnail` |
| ギフト | `https://accounts.booth.pm/library/gifts?page=N` | 同上 |
| 注文一覧 | `https://accounts.booth.pm/orders?page=N` | 注文ID: `https://accounts\.booth\.pm\/orders\/(\d+)` |
| 注文詳細 | `https://accounts.booth.pm/orders/{id}` | DLリンク: `https://booth\.pm\/downloadables\/(\d+)`（DOM クラスは「最も壊れやすい」と原作者コメントあり） |
| ダウンロード | `https://booth.pm/downloadables/{id}` | **302 で署名付き URL へリダイレクト**。ファイル名はリダイレクト先パスの最後のセグメント。リダイレクト先ホストは未確認（別ホストなら cstria0106 の「別ホスト = AUTH_REQUIRED」判定に引っかかるので例外処理が必要） |

### 2.4 規約上の制約 → 設計への反映

- pixiv サービス共通利用規約 **第14条23号**（サーバーへの過度な負荷の禁止）、**第14条24号**（機械的・短時間大量の操作の禁止）
- pixiv 登録商標ガイドライン「アプリケーション、各種サービス等への使用について」: **クローラー等で作品を収集する行為、極端な負荷をかける行為は禁止**。規約違反でなくても停止を求められる場合あり
- BOOTH 個別規約の第7条（禁止行為）は出品者向けの内容のみで、自動アクセスに関する条項は見当たらず。ただし**冒頭〜第3条は未読（取得時に途切れた）→ 未確認**
  → 【2026-10-12】全 16 条を確認し、自動アクセスに関する条項は無かった（§7-6、docs/research-2026-10-12.md §1）
- robots.txt: `Disallow: /terms, /carts, /cart` のみ

**設計上の帰結**:
1. **自分のアカウントのデータのみ**扱う。カタログ全体のクロール機能は作らない（検索はユーザーの明示的クエリ 1回 = 1〜数ページまで）
2. **全リクエスト直列 + 1 req/s 以上の間隔**、429/503 は指数バックオフ（最大3回）→ 失敗時 `RATE_LIMITED`
3. **v1 は read-only**（GET/HEAD のみ）。ウィッシュリスト追加・カート操作など POST 系はやらない
4. ダウンロードは**明示的オプトイン**（環境変数 `BOOTH_MCP_ENABLE_DOWNLOAD=1` かつ保存先ディレクトリ指定時のみツール公開）
5. 「非公式・pixiv/BOOTH とは無関係」を README とツール説明に明記

---

## 3. MCP ツール設計（v1）

| ツール | 入力 | 出力 | 認証 | フェーズ |
|---|---|---|---|---|
| `booth_login` | `timeout_sec?` | ログイン結果 | — | 1 |
| `booth_auth_status` | — | ログイン有無・ユーザー名 | 要 | 1 |
| `booth_logout` | — | session/profile 削除 | — | 1 |
| `booth_get_item` | `item_id` or `url` | 商品詳細（items/{id}.json を整形） | 不要（ログイン時は `wished/order/gift` が付く） | 2 |
| `booth_search_items` | `query, category?, tags?, sort?, page?(≤5), only_free?, adult?` | 商品サマリ一覧 | 不要 | 2 |
| `booth_suggest_tags` | `term` | タグ候補 | 不要 | 2 |
| `booth_list_library` | `page?`, `all?`(全ページ。上限付き), `query?`(取得後にローカルでフィルタ) | 購入済み商品一覧（item_id, 名前, ショップ, サムネ, DL可能ファイル） | 要 | 2 |
| `booth_list_gifts` | 同上 | ギフト一覧 | 要 | 2 |
| `booth_list_orders` | `page?` | 注文一覧（注文ID, 日付, 金額, 状態） | 要 | 2 |
| `booth_get_order` | `order_id` | 注文詳細（商品, DLリンクID）。**住所・電話・氏名はマスク** | 要 | 2 |
| `booth_download` | `downloadable_id`, `dest_dir?` | 保存パス・サイズ | 要 + オプトイン | 3 |
| `booth_check_updates` | `item_ids?` | 前回取得時からDLファイル構成が変わった商品 | 要 | 5 (任意) |

出力方針: MCP には**整形済み JSON（必要フィールドのみ）**を返し、大量件数は件数上限 + `next_page` を返す。署名付き URL・cookie はログにも出力にも出さない。

---

## 3.5 VRChat 購入者向け機能

### 3.5.1 方針

- **判定はツールでやり切らず、「根拠」を返して LLM（MCP クライアント）に判断させる。** 説明文の書き方は出品者ごとにばらばらなので、ツール側はルールベースの抽出と `confidence` / `evidence`（該当箇所の引用）までにする。サーバー内で LLM は呼ばない
- **推測で「対応」と言わない。** 根拠が無ければ `unknown` を返す
- 対応アバターは**購入済み商品と、ユーザーが明示的に指定した商品・検索**に対してのみ計算する（ストア全体はクロールしない。§2.4）

### 3.5.2 対応アバターの抽出ロジック（`items/{id}.json` から）

優先度順に照合し、ヒットした箇所を `evidence` に残す。

| # | ソース | 例 | confidence |
|---|---|---|---|
| 1 | `variations[].name` | 「しなの用」「桔梗用」— 衣装はアバター別にバリエーションを分けて売られることが多い | high |
| 2 | `tags[].name` | 「しなの」「しなの対応」 | high |
| 3 | `description` 内の「対応アバター」「対応モデル」「【対応】」などの見出しに続く行 | 「対応アバター：しなの / 桔梗 / …」 | high |
| 4 | `name`（商品名） | 「【しなの対応】〇〇」「〇〇（桔梗用）」 | medium |
| 5 | `description` 全文中の単純な出現 | 「しなのちゃんにも着せられます」 | low（参考扱い） |

- **購入済み商品の場合**: 購入したバリエーション / ダウンロードファイル名（例 `Outfit_Shinano_v1.2.zip`）にもアバター名が入ることが多い → 「そのうち**自分が持っているのはどのアバター版か**」も返す
- 否定表現（「〇〇には非対応」「〇〇は対象外」）は除外ルールを用意し、ヒットしたら `not_supported` として返す

### 3.5.3 アバター辞書

- `avatars.json`（ユーザーが編集可能）: 正規名 + 別名（ひらがな/カタカナ/英字/略称）。例: `{ "id": "shinano", "names": ["しなの", "Shinano"] }`
- **初期値はライブラリから自動生成**: 購入済み商品のうちカテゴリ **3Dキャラクター（id 208）** のものを「所持アバター候補」として登録し、ユーザーが確認・別名を追記する
- 誤検出しやすい短い名前・一般名詞と被る名前は「タグ一致または見出し内のみ有効」フラグで制御

### 3.5.4 依存ツール・環境の検出

説明文・タグから辞書照合で抽出（同じく `evidence` 付き）:
- シェーダー: lilToon / Poiyomi / UTS など
- ツール: Modular Avatar / VRCFury / Avatar Optimizer / NDMF / FaceEmo など
- プラットフォーム: 「Quest対応」「Android対応」「PC専用」→ `quest_support: yes | no | unknown`

### 3.5.5 カテゴリ

| id | 名前 | 出典 |
|---|---|---|
| 208 | 3Dキャラクター | items/{id}.json で確認済み |
| 209 | 3D衣装 | Kyure-A/mcp-booth のコード（要確認） |
| 210 | 3D小道具 | 同上（要確認） |
| 215 | 3Dツール・システム | 同上（要確認） |
| 216 | 3Dモーション・アニメーション | 同上（要確認） |
| ? | 3D装飾品 | 未確認 |

→ `vrchat_kind: avatar | costume | accessory | tool | motion | other` に正規化して返す。

### 3.5.6 追加ツール

| ツール | 入力 | 出力 | 認証 |
|---|---|---|---|
| `booth_get_item`（拡張） | 既存 + `include_vrchat?: true` | 既存の出力 + `vrchat: { kind, compatible_avatars[{avatar, confidence, source, evidence}], not_supported[], dependencies[], quest_support }` | 不要 |
| `booth_check_compatibility` | `item_id`, `avatar` | `supported \| not_supported \| unknown` + 根拠の引用 | 不要 |
| `booth_list_library`（拡張） | 既存 + `avatar?`, `kind?`, `dependency?` | 条件に合う購入品 + 自分が持っているアバター版 | 要 |
| `booth_list_my_avatars` | — | ライブラリ内の 3Dキャラクター + 辞書 | 要 |
| `booth_search_for_avatar` | `avatar`, `kind?`(既定 costume), `query?`, `page?(≤3)` | BOOTH 検索（`/ja/search/{q}` + `tags[]`）の結果に対応度を付けたもの | 不要 |
| `booth_sync_library_metadata` | `max_items?` | 購入品の items/{id}.json をキャッシュに取り込む（進捗・残件数） | 要 |

### 3.5.7 キャッシュ（リクエスト数対策・必須）

ライブラリ全件の対応アバターを計算するには購入品ごとに `items/{id}.json` が必要。1 req/s だと **300件で約5分**かかる → キャッシュ前提にする。

- 保存先: `~/.booth-mcp/cache/items/{item_id}.json`
- 形式: `{ "item_id": 123, "fetched_at": "2026-10-12T03:00:00Z", "etag": null, "item": { ...items/{id}.json の中身... } }`（日時は ISO 8601 UTC）
- TTL 7日（設定可）。ライブラリ一覧でファイル構成が変わった商品は即時再取得
- **MCP ツールはキャッシュ優先**。未取得分は1回の呼び出しにつき上限（例 20件）まで取得し、残件数を返す。全件取り込みは CLI の `sync` コマンドで事前に行う運用
- 抽出結果（対応アバター・依存）はキャッシュから都度計算する（辞書を更新したら即反映されるように、抽出結果自体は保存しない）

### 3.5.8 Unity プロジェクトとの突き合わせ（後回し・別 MCP と組み合わせる）

- booth-mcp 自体には Unity 側のスキャン機能を作り込まない。購入品ごとのダウンロードファイル名・商品名を返すまでにする
- 「この ALCOM プロジェクトに入っている購入品は？」は、Claude が booth-mcp と既存の isuzu-unity MCP（またはファイル読み取り）を組み合わせて答える運用でまず試す。足りなければ CLI に `unity-check <projectPath>`（`Assets/` のフォルダ名と `Packages/vpm-manifest.json` を読み取るだけ）を追加

### 3.5.9 代替案: Hoard のデータを読む

BOOTH へのアクセス・ログイン・ダウンロードを Hoard に任せ、booth-mcp は Hoard のローカルデータを読んで VRChat 向けの判定だけをする構成もあり得る（スクレイピングを自前で持たずに済む）。ただし **Hoard のローカルデータ形式は未確認**（§7）。Phase 0 で確認し、使えそうなら Phase 2 の一部を置き換える。

---

## 4. ディレクトリ構成（フォーク後の想定）

```
src/
  browser/
    client.ts          # ログイン: 開く URL と成功判定を accounts.booth.pm/settings ベースに変更
    http-client.ts     # origin 可変化、429 バックオフ追加、DL 用リダイレクト例外
    read-only-guard.ts # そのまま
  booth/
    public.ts          # items/{id}.json, autocomplete, search
    library.ts         # library / gifts（ページング）
    orders.ts          # orders 一覧 / 詳細
    download.ts        # downloadables → 署名URL → ファイル保存（パストラバーサル対策）
  parsers/
    library.ts  orders.ts  search.ts   # cheerio。失敗時は BOOTH_CHANGED
  vrchat/
    avatars.ts         # アバター辞書の読み込み・ライブラリからの初期生成
    compatibility.ts   # 対応アバター抽出（§3.5.2）。純関数、I/O なし
    dependencies.ts    # 依存ツール・Quest 対応の抽出（§3.5.4）
    kind.ts            # カテゴリ → vrchat_kind 正規化
  cache/
    item-cache.ts      # items/{id}.json のキャッシュ（TTL・上限付き取得）
  privacy.ts           # 住所・電話・メールのマスク（上流の流用）
  server.ts            # MCP ツール登録（zod スキーマ）
  cli.ts               # CLI サブコマンド（同じ service 層を呼ぶ）
  service.ts           # ツール/CLI 共通のユースケース層
tests/
  fixtures/            # 実ページを1回保存→個人情報を除去した HTML
  *.test.ts            # パーサ・HTTP・ガード・stdio 契約
  live/*.live.test.ts  # BOOTH_MCP_LIVE=1 のときのみ実通信
```

---

## 5. フェーズ計画

### Phase 0: ベース確立と実ページ調査（最優先）
- [x] cstria0106/booth-mcp をフォーク（`git init` → `upstream` 追加 → merge）、パッケージ名を `booth-library-mcp`（v0.1.0）に変更（のち §7-7 により `avatar-closet-mcp` に改名）、既存テストが通ることを確認（Windows の CRLF でテストが落ちるため `.gitattributes` で LF 固定）
- [ ] 実ブラウザでログインし、以下の**実 HTML を保存**して構造を確認（§7 の検証項目を潰す）:
  `accounts.booth.pm/library`, `/library/gifts`, `/orders`, `/orders/{id}`, `/wish_lists`, 検索結果ページ
  - [x] 検索結果ページ・`items/{id}.json` 14件・タグ補完は**ログイン不要分を実取得**（`tests/fixtures/public/`、2026-10-12、計20リクエスト）
  - [x] ログイン必須ページ（settings / library / gifts / orders / orders/{id} / wish_lists）を**実ログインで取得**（2026-10-12、ユーザーが手動ログイン。保存先は gitignore 済みの `tests/fixtures/private/`）
- [x] `downloadables/{id}` のリダイレクト先ホストを確認 → **`s6.booth.pm`**（実測。記録したのはホスト名だけ）。許可リスト `*.booth.pm` の範囲内
- [x] 保存 HTML から個人情報を除去して `tests/fixtures/` に配置 → 実ページの構造（タグ・クラス・入れ子）を写し、文字列と ID はすべて架空にして `tests/fixtures/buyer/` を作り直した。差分の個人情報検査は 0 件
- **完了条件**: 全ページの抽出セレクタが確定し、fixture が揃っている → **達成**（空状態・最終ページ・複数商品の注文など、実例が無かったケースは §9.2 に残す）

### Phase 1: 認証の汎用化
- [x] ログイン先を `https://accounts.booth.pm/settings`（またはライブラリ）に変更、成功判定を「最終 URL が `accounts.booth.pm` 上」に変更
- [x] `adult=t` cookie を storageState に注入
- [x] `booth_auth_status`: `/settings` への GET で有効性確認
- [x] `booth_logout`: session.json と profile dir を削除（マーカーファイル付きの profile のみ削除。保護ディレクトリの祖先は拒否）
- [x] CLI: `login / status / logout`
- [x] 出品者専用ツール・パーサを削除（購入者専用フォーク）。session.json はアトミック書き込み・他プロセスの変更を上書きしない
- **テスト**: リダイレクト=未ログイン判定、cookie 書き戻し、session ファイル権限

### Phase 2: 読み取りツール
- [x] `booth_get_item`, `booth_suggest_tags`（JSON 系、最も壊れにくいので先に）
- [x] `booth_search_items`（HTML パース、ページ上限 5）
- [x] `booth_list_library` / `booth_list_gifts`（ページング、`all=true` は最大 20 ページで打ち切り。「ページ番号不一致 or 新規 ID なし」でも停止。2026-10-12 実測では範囲外ページは最終ページではなく空の一覧を返す）
- [x] `booth_list_orders` / `booth_get_order`（privacy マスク適用。注文詳細は許可フィールドのみで再構築、状態・支払方法は既知語彙のみ）
- [x] 429/503 指数バックオフ（2/4/8 秒、Retry-After は 30 秒上限）
- **テスト（TDD）**: fixture → パーサの単体テストを先に書く。構造変化時に `BOOTH_CHANGED` を返すこと。カバレッジ 80% 以上

### Phase 2.5: VRChat 購入者向け機能（§3.5）
- [x] Phase 0 で保存したライブラリ内の実商品（衣装・アバター・小物）の items/{id}.json を集め、個人情報が無いことを確認して fixture 化（**抽出ロジックの評価用データセット**。正解ラベルを手で付ける）→ ログイン前のため**公開商品 14 件**（衣装 7・アバター 2・小物/髪 2・ツール 2・プレハブ 1）で代替し、`compat-labels.json` に正解ラベル。自分のライブラリでの評価は §9
  → 【2026-10-12】全件 `sync` 後、購入品のうち 208/209/210/217/230 の items JSON を gitignore 済みの `tests/fixtures/private/library-eval/` に集め、衣装中心に層化抽出した 52 件に手でラベルを付けた（購入リストは個人情報なのでコミットしない）。`tests/vrchat-library-eval.test.ts` がそのディレクトリがあるときだけ同じ指標を測る（CI では skip）。結果は §7-11
- [x] `vrchat/compatibility.ts`: 抽出ロジックを TDD で実装 → 14件で high の誤検出 0・再現率 110/110（ただし同じデータでチューニングしたため過学習の可能性あり。実ライブラリでの再評価が必要）→ 【2026-10-12】実ライブラリで再評価済み（下の「評価」）
- [x] `vrchat/avatars.ts`: 辞書（シード 56 体 + ユーザーの `avatars.json`）+ ライブラリの 3Dキャラクターからの初期生成（CLI `avatars init`）
- [x] `vrchat/dependencies.ts`, `kind.ts`
- [x] `cache/item-cache.ts` + CLI `sync` コマンド（TTL は `BOOTH_MCP_CACHE_TTL_DAYS`、既定 7 日。ファイル構成が変わった商品は `forceIds` で即時再取得）
- [x] ツール: `booth_get_item` 拡張, `booth_check_compatibility`, `booth_list_library` 拡張, `booth_list_my_avatars`, `booth_search_for_avatar`, `booth_sync_library_metadata`
- [x] **評価（2026-10-12）**: 公開商品 14 件（コミット済みの fixture）と、自分のライブラリから手でラベルを付けた非公開サンプル 52 件（gitignore 済みの `tests/fixtures/private/library-eval/` に置きコミットしない。`tests/vrchat-library-eval.test.ts` はこれが無いと skip）で評価。規則修正後の非公開サンプルでの結果: high の誤検出 0、全信頼度の誤検出 1（low）、再現率 99.6%（high のみ 99.1%）、kind 正解率 92.3%（誤りは出品者が髪型・ヘイロー・Prefab・ギミックを衣装／小道具カテゴリに出品していたもの）、依存の完全一致 98.1%（詳細は §7-11）
- **完了条件**: 「持ってる衣装でしなの対応のものは？」「この URL の商品は桔梗に対応してる？」に根拠付きで答えられる。未知のケースは `unknown` を返す

### Phase 3: ダウンロード（オプトイン）
- [x] `BOOTH_MCP_ENABLE_DOWNLOAD=1` のときのみ `booth_download` を登録（加えて `BOOTH_MCP_DOWNLOAD_DIR` の絶対パス指定が必須。CLI `download` も同じオプトインが必要）
- [x] `downloadables/{id}` → 302 の Location を検証（許可ホストのみ）→ ストリーミング保存（署名付き URL には cookie を送らない。タイムアウトあり、既定上限 4 GiB）
- [x] ファイル名サニタイズ・保存先外への書き込み禁止（パストラバーサル対策）・既存ファイルは上書きしない
- [x] 署名付き URL をログ・エラーメッセージに含めない
- **テスト**: 不正ファイル名、許可外ホストへのリダイレクト、オプトイン無効時にツールが存在しないこと

### Phase 4: CLI 整備
- [x] `avatar-closet-mcp library [--all] [--json]`, `gifts`, `orders`, `order <id>`, `item <id>`, `search <q>`, `download <id> --out <dir>`（ほかに `tags`, `compat`, `avatars [init]`, `sync`, `updates`, `unity-check`）
- [x] 人間向け表形式 / `--json` 切替。MCP と同じ service 層を使い、ロジックを二重に持たない。終了コードはエラーコード別（README 参照）

### Phase 5（任意）: 便利機能
- [x] `booth_check_updates`: ライブラリの DL ファイル構成をローカルにキャッシュし差分検出（omnooth の `outdated` 相当。全ページ取得できた場合のみ基準を更新）
- [x] Unity プロジェクトとの突き合わせ（§3.5.8）: CLI `unity-check <projectPath>` を追加（`Assets/` の 2 階層までのフォルダ名と `vpm-manifest.json` / `manifest.json` のみ読む）。isuzu-unity MCP との組み合わせ運用は実プロジェクトで要試行
- [x] 購入品の更新通知と対応アバターを組み合わせる（`booth_check_updates` / CLI `updates` の `avatar` 指定）

### 各フェーズ共通
- [x] code-reviewer / security-reviewer エージェントでレビュー → CRITICAL/HIGH なし。MEDIUM/LOW は修正済み（セッションのアトミック書き込み、`INTERNAL_ERROR`、ツール結果に信頼できない出品者テキストである旨の `_notice`、ダウンロード強化、ログアウト時の削除の安全化など）
- [x] live テストは手動実行のみ（CI では走らせない＝ BOOTH に負荷をかけない）。開発中の BOOTH へのリクエストは公開ページの fixture 取得 20 回のみ

---

## 6. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| BOOTH の HTML 変更 | 一覧系が壊れる | JSON エンドポイント優先、パーサを1ファイルに隔離、`BOOTH_CHANGED` で明示エラー、fixture 更新手順を README に記載 |
| 規約・アカウント制限 | アカウント停止の可能性 | 自分のデータのみ、1 req/s 直列、クロール機能なし、自動ログインなし、read-only |
| Cloudflare の bot 判定強化 | 403 | Playwright request context を使う。悪化したら「実ブラウザ context 経由で fetch」に切替できる設計にしておく |
| セッション漏洩 | アカウント乗っ取り | session/profile を 0600/0700、リポジトリ外（ユーザーディレクトリ）に保存、`.gitignore`、ログに cookie を出さない。永続 profile dir には pixiv の cookie も残るため logout で profile dir ごと削除。Windows は ACL で保護されるかを確認 |
| 個人情報（住所等）が LLM に渡る | プライバシー | 注文詳細はデフォルトでマスク |
| 上流の変更 | マージ困難 | 認証/HTTP 層は上流と差分を小さく保つ |

---

## 7. 検証が必要な項目（未確認・推測で実装しないこと）

1. **ライブラリ/ギフト/注文ページの現行 HTML 構造** — BoothDownloader のセレクタ（`nav-item last-page`, `l-library-item-thumbnail`, 注文詳細の `sheet sheet--p400 ...`）が今も有効か
   → 【2026-10-12 実ページで確認】ライブラリとギフトのカード（`div.bg-white.p-16`）とページャ（Kaminari 形式）は OSS 調査どおりで、修正不要だった。注文一覧は各注文が `.l-orders-index > a.nav-reverse` のリンクで、状態は `.order-state` バッジ（一覧に金額は出ない）。注文詳細は状態バッジ・`.text-14 b a`（商品名）・ショップごとのブロックという構造。いずれも修正済み。settings ページは JS で描画されるので、表示名はヘッダの `#js-user-pulldown[data-current-user]` から取る。【2026-10-12 追加で実測】範囲外ページ（`?page=` が最終ページより大きい）は最終ページを返さず、「購入したダウンロード商品はありません」の空状態と、first / prev / gap / next / last-page だけのページャを返す（rel="next" が残るので `has_next` は `a.last-page` を優先するよう修正）。最終ページのページャ（first-page / prev / gap / 番号 / current、next と last-page なし）はライブラリと注文一覧の両方で確認。ギフト一覧は 1 ページで空のページャ。複数商品の注文は一覧では商品ごとに同じ `/orders/{id}` へのカードが並び、詳細では同じ `.sheet-group` に商品ごとの sheet が並ぶ。他人へのギフトとして買った注文は詳細の種別が「ギフト」で DL 行が無く、`/gifts/{token}/edit` の非公開リンクがある（パーサは返さない）。`/library/free_downloads` はライブラリと同じカードだが DL 行が無い（`tests/fixtures/buyer/free-downloads.html`）
2. **ウィッシュリストの一覧取得方法** — `accounts.booth.pm/wish_lists.json?item_ids[]=...` は**指定商品がお気に入り済みかの確認用**であって一覧 API ではない。一覧は `accounts.booth.pm/wish_lists` の HTML か別 API か未確認
   → 【OSS 調査】`/wish_lists` は JS で描画される器だけ。一覧は `GET accounts.booth.pm/wish_list_name_items.json?page=N[&wish_list_name_code=]`（`items[]` と `pagination`）、リスト名は `/wish_list_names.json`。v1 では未実装（§9.3）
   → 【2026-10-12 実測】3 エンドポイントとも 200（リダイレクトなし）。キーと型は `tests/fixtures/buyer/WISHLIST_CAPTURED.md`
   → 【2026-10-12】実装済み（`booth_list_wishlist` / `booth_list_wishlist_names`、CLI `wishlist`。§9.3）
3. **検索結果の JSON 版の有無** — 現状 HTML パース前提
   → 【確認済み】JSON 版は無い（`items.json` は HTML 検索へ 302）。カードは `li.item-card[data-product-id]`、1 ページ 60 件
4. **`downloadables/{id}` のリダイレクト先ホスト**
   → 【2026-10-12 実測】**`s6.booth.pm`**（302 の Location のホストだけを記録）。OSS でも `s6.booth.pm`（Stashly）と `download.booth.pm`（omnooth）が使われている。cookie は不要（OSS 調査）。許可リストは `*.booth.pm`。実際のファイル保存までは試していない
   → 【2026-10-12】実際のダウンロードも成功（§9.2）
5. **"BOOTH Library Manager" の正体** — omnooth が `booth-library-manager://item-import?dlurl=...&item_id=...&order_id=...&variation_id=...` という URL スキームを登録しており、BOOTH 側にこのスキームへ受け渡す仕組みがあると推測されるが、**公式アプリかどうかは2回検索しても確認できず**。公式の受け渡し口なら DL 機能はこれに乗る方が安全な可能性あり
   → 【2026-10-12 調査】**BOOTH 公式**のデスクトップアプリ（告知 `booth.pm/announcements/893`、2025-12-24、Windows 版アーリーアクセス）。deeplink `/downloadables/{id}/deeplink?client=booth-library-manager` は BOOTH が自社アプリへ受け渡すためのもので、第三者のツールが使う受け渡し口ではない。DL は従来どおり `/downloadables/{id}` を使う（docs/research-2026-10-12.md §3）
6. **BOOTH 個別規約の冒頭〜第3条**（取得時に途切れて未読）
   → 【2026-10-12 調査】自分のアカウントのデータを 1 req/s 以下で読むだけの個人用・読み取り専用ツールと矛盾する条項は無い。BOOTH ガイドライン（2026-07-08 改定）の「スクレイピング行為について」は、プログラムによる取得を一律には禁じず、サーバーへの極端な負荷・権利侵害・損害を基準に制限する。サービス共通利用規約第14条の 23 号（サーバーへの過度な負荷）・24 号（機械的・短時間大量の操作）にも当たらない設計（docs/research-2026-10-12.md §1）
7. **pixiv 登録商標ガイドライン上、ツール名・パッケージ名に「BOOTH」を含めてよいか**（非公式である旨の表記要件含む）
   → 【2026-10-12】公式アプリ「BOOTH Library Manager」との混同を避けるため、パッケージ・CLI・データフォルダの名前を `booth-library-mcp` から **`avatar-closet-mcp`** に改名した（旧フォルダは起動時に 1 回だけ自動で移動）。README・パッケージの説明に、BOOTH 向けの非公式ツールで pixiv / BOOTH が作成・配布するものではない旨（日本語と英語）を記載。ツール名 `booth_*` は連携するプラットフォームを示す機能的な表記としてそのまま、環境変数 `BOOTH_MCP_*` とスキルのフォルダ `skills/booth` は互換のためそのまま（docs/research-2026-10-12.md §2）
8. **ログイン時の `items/{id}.json` の `order` / `gift` フィールドの中身** — 所有判定に使えるか
   → 【2026-10-12 実測（全件 sync でログイン状態のまま取得した購入品すべて）】`wished` は boolean、`order` と `gift` は全件 null（受け取ったギフトも null）なので所有判定には使えない。代わりに購入したバリエーションの `status` が `addable_to_cart` ではなく `already_bought_digital` になる（購入品のうち 1 件を除く全件。受け取ったギフトには付かない）。`src/booth/public.ts` の `viewer.owned_variation_ids` で返すようにした（キャッシュには残さず、保存時に `addable_to_cart` へ戻す）。商品・バリエーションの `past_purchase_count` は全件 0、`order_url` は全件 null
9. セッション cookie の有効期限・ローテーション頻度
   → 【2026-10-12 実測（値は見ずに名前・ドメイン・期限とハッシュの比較のみ）】セッションは `.booth.pm` の `_plaza_session_*`（httpOnly, Secure, SameSite=Lax）。期限は「最後に応答を受けた時刻 + 1 年」で、応答ごとに書き戻される（ローリング）。値もログイン後に変わっており、sync の前後と終了時の 3 時点でハッシュがすべて異なった（リクエスト中にローテーションされる）。`cf_clearance` はログイン時刻 + 1 年で固定、`__cf_bm` は約 30 分
10. **カテゴリ ID**: 208（3Dキャラクター）以外は Kyure-A/mcp-booth のコード由来で未確認。3D装飾品の ID は不明
    → 【確認済み（items JSON）】208 3Dキャラクター、209 3D衣装、210 3D小道具、214 3Dテクスチャ、215 3Dツール・システム、216 3Dモーション・アニメーション、**217 3D装飾品**、230 3D髪型。検索 URL のカテゴリ指定は ID ではなく名前
11. **対応アバター抽出の精度**: 実際の購入品データで正解率を測るまで、high/medium/low の閾値は仮
    → 【公開 14 件で測定】high の誤検出 0、再現率 110/110（high のみなら 109/110）。同じデータで規則を調整したため過学習の可能性あり。items JSON の `description` は冒頭部分だけなので、本文にしか書かれていない対応アバターは拾えない
    → 【2026-10-12 自分のライブラリ 1 ページ目の 10 件で抜き取り確認（規則は未調整）】衣装 7・小物 2・ツール 1。うち 8 件で対応アバターを検出し、すべて high（バリエーション名 6、アバター名タグ 2）。low/medium だけのものは 0、unknown は 2（ツールと小物。妥当）。目で見てわかる誤検出は無し。件数が少ないので、全件 `sync` 後の再評価が望ましい
    → 【2026-10-12 自分のライブラリから層化抽出した 52 件（衣装 30・アバター本体 8・小物/髪/装飾 12・ツール等 2、ラベル対象 524 組のうち辞書外 72 組を除く 452 組）】規則の修正前: high の誤検出 0、全信頼度の誤検出 4（すべて low の本文一致）、再現率 96.7%（high のみ 95.1%）、kind 正解率 92.3%、quest 100%（ほぼ unknown）、依存の完全一致 98.1%。主な取りこぼしは「対応済みアバター」見出しを見出しと認識しない・60 行を超える一覧の打ち切り、区切りなしの連結名（`シフォンショコラライム`）、ひらがな表記（`あいり`）、英字の隣接 2 文字の入れ替わり誤記（`Selesita`, `Mlify`）。修正後: high の誤検出 0、全信頼度の誤検出 1（体型スケール表の名前を low で拾う）、再現率 99.6%（high のみ 99.1%）、他は同じ。残る取りこぼしはグループ名だけのバリエーション（`Mamefriends` = キプフェル + まめひなた）。kind の不一致 4 件は出品カテゴリと中身の食い違い（衣装カテゴリの髪型・ヘイロー・Prefab、小道具カテゴリのギミック）。公開 14 件の評価は変化なし
12. **Hoard のローカルデータ形式**（保存場所・スキーマ・暗号化の有無）— §3.5.9 の代替案を採るかの判断材料
    → 【OSS 調査】保存先は `%LOCALAPPDATA%\Hoard`（`HOARD_DATA_DIR` で変更可）。一覧は DL フォルダの平文 JSON `catalog.json`（`format:"hoard-catalog"`、version 3/4、改ざん検知の HMAC 付き、第三者が読む前提で文書化あり）と `<Store>/_manifest.json`（商品 ID ごとに DL ファイルの名前・サイズ・日時。内部形式で安定性は保証されない）。暗号化されているのはログイン cookie だけ（DPAPI 等）。**読み取りは可能**だが、ファイルごとのバージョン文字列は無く、Hoard で DL 済みの分しか見えない。→ v1 では自前取得を採用。Hoard 連携は将来の任意機能
13. **ライブラリページに購入バリエーション名やダウンロードファイル名が出ているか** —「どのアバター版を持っているか」の判定に必要
    → 【2026-10-12 実ページで確認】ライブラリには DL ファイル名が出るが、バリエーション名は出ない。ただし行ごとの「その他のDL方法」ドロップダウンの JSON にファイルごとの `variation_id` がある（未使用。これを使えば持っている版を ID で特定できる）。今回の注文詳細にはバリエーション名が出ていなかった。現状、持っている版はファイル名（信頼度 medium）で判定している
    → 【2026-10-12】ログイン時の items JSON で購入したバリエーションの `status` が `already_bought_digital` になると判明（§7-8）。持っている版は ID で特定できる（`viewer.owned_variation_ids`）

---

## 8. 参考にした既存実装

- cstria0106/booth-mcp — 出品者 read MCP（フォーク元候補） https://github.com/cstria0106/booth-mcp
- quolu/booth-mcp — 出品者 write MCP、Cloudflare/TLS の知見 https://github.com/quolu/booth-mcp
- Kyure-A/mcp-booth — 検索のみ MCP https://github.com/Kyure-A/mcp-booth
- thisoverride/BoothPM-SDK (npm `booth-pm-sdk`) — 公開データ SDK + pixiv ログイン https://github.com/thisoverride/BoothPM-SDK
- Myrkie/BoothDownloader — 購入品 DL CLI（cookie 名・ページ構造の出典） https://github.com/Myrkie/BoothDownloader
- tukiminya/omnooth — ライブラリ管理 CLI（実験段階） https://github.com/tukiminya/omnooth
- Hoard — VRChat アセット管理（BOOTH ログイン・更新検知・Unity 連携・CLI） https://github.com/Soloflighter1010/Hoard-Asset-Manager
- KonoAsset — VRChat アセット管理（101★） https://github.com/siloneco/KonoAsset
- VRC-Avatar-Explorer — 対応アバター管理・unitypackage インポート https://github.com/puk06/VRC-Avatar-Explorer
- BOOTH Package Linker — 有料のライブラリ管理アプリ https://booth.pm/ja/items/8639617
- VRCFinder — 説明文解析による対応アバター検索（Web） https://uhiyama-lab.com/en/product/vrcfinder/
- pixiv 利用規約 https://policies.pixiv.net/

---

## 9. 実装状況と残作業（2026-10-12）

### 9.1 実装済み（ブランチ `feat/buyer-mcp`、`main` は upstream と同一に保持）

- MCP ツール 18 個（オプトイン時は `booth_download` を加えて 19 個）。CLI は同じ service 層を使う
- lint / typecheck / build / check:distribution / check:package すべて通過。テスト約 1000 件（live テストは除外）
- 依存の追加なし（upstream の 4 依存のまま）
- **本物の経路での確認（2026-10-12、リクエスト 1 回）**: ビルドした CLI で `item 4866933 --vrchat` を実行。実 HTTP クライアント → BOOTH の items JSON → スキーマ検証 → キャッシュ → 対応判定まで通った。続く `compat 4866933 桔梗` はキャッシュから「supported（high、根拠: バリエーション名 Kikyo ほか）」と回答。Cloudflare による 403 は発生しなかった

### 9.2 実ログインでの検証（2026-10-12 実施）と残り

実施済み（ユーザーが手動ログインし、エージェントが BOOTH へ 24 リクエスト）:
- [x] `node dist/cli.js login` → `status` でログイン済みを確認（Playwright を node で実行。bun では playwright-core の Set-Cookie 処理で失敗するため、取得スクリプトは `npx tsx scripts/capture-fixtures.ts` で動かす）
- [x] 実ページを取得してパーサと照合・修正し、fixture を作り直した（§5 Phase 0、§7-1）
- [x] CLI の `library` / `gifts` / `orders` / `order` / `library --avatar しなの` がすべて正常終了
- [x] `BOOTH_MCP_LIVE=1 bun run test:live` → 1 passed
- [x] ダウンロードのリダイレクト先ホスト `s6.booth.pm` を実測（§7-4）

残り（実例が無かった、または負荷を避けて実行しなかったもの）:
1. ~~全件 `sync`~~ → 【2026-10-12 実施】`sync --max 400` で購入品 164 件を 208 秒で取り込み、エラー 0（削除済みなどで 404 の 13 件は unavailable として記録）。精度評価は §7-11
2. 実例が無く未確認の構造 → 【2026-10-12】最終ページのページャ・複数商品の注文・ギフト購入の注文は確認済み。アカウントの一覧で範囲外のページを指定すると最終ページではなく**空の一覧**が返ることを確認し、`has_next` の判定の不具合を修正した。空状態の実際のマークアップも取得済み（範囲外ページで観察。§7-1）。ほしいものリストと無料ダウンロードのエンドポイントも実際に取得した（§7-2、§7-1）。
   **このアカウントでは観察できないもの**: 物理商品の注文と配送先ブロック（候補の注文 5 件はすべてギフト購入かダウンロード商品だった）、「発送完了」以外の状態、クレジットカード以外の支払方法、空の注文一覧・空のほしいものリスト・空の無料ダウンロードのページ、サインインページ、英語 UI（本ツールは設計上つねに日本語のページを要求する）
3. ~~`booth_download` で実際にファイルを 1 件保存~~ → 【2026-10-12 実施】35 KB の PDF 1 件を保存できた（`content_type: application/pdf`、ファイル先頭は `%PDF`）。確認後に削除
4. ライブラリの `variation_id`（§7-13）を使って「持っている版」をファイル名ではなく ID で判定する（改善案）→ items JSON の `already_bought_digital` でも特定できる（§7-8）
5. 取得した実ページ `tests/fixtures/private/` は個人情報を含むので、不要になったら削除する

### 9.3 v1 の範囲外として見送ったもの

- ~~ウィッシュリスト一覧~~ → 【2026-10-12】実装済み（`booth_list_wishlist` / `booth_list_wishlist_names`、§7-2）
- ~~ライブラリの「無料ダウンロード」タブ（`/library/free_downloads`）~~ → 【2026-10-12】実装済み（`booth_list_free_downloads`、CLI `free`）
- npm への公開: まだ行っていない（公開するかはユーザーが決める）。パッケージ名は §7-7 のとおり `avatar-closet-mcp` に変更済み
