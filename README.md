# avatar-closet-mcp

> [!IMPORTANT]
> **BOOTH 向けに作られた非公式ツールで、pixiv / BOOTH が開発・配布するものではありません。** 個人が開発したもので、ピクシブ株式会社・BOOTH・BOOTH Library Manager とは提携・承認・協賛の関係にありません。本ツールについて BOOTH 事務局やショップへ問い合わせないでください。BOOTH の画面構造が変わると一部の機能が動かなくなることがあります。
>
> **An unofficial tool built for BOOTH (booth.pm) buyers. It is not made or distributed by pixiv Inc. or BOOTH, and is not affiliated with or endorsed by pixiv Inc., BOOTH, or BOOTH Library Manager.**
>
> 「pixiv」「BOOTH」はピクシブ株式会社の商標または登録商標です。公式サービスとの混同を避けるため、本ツールの名前には「BOOTH」を含めていません（[調査メモ](docs/research-2026-10-12.md) §2）。MCP サーバー名 `booth`・ツール名 `booth_*`・環境変数 `BOOTH_MCP_*` の「booth」は、連携先のプラットフォームを示す機能的な表記です。
> "pixiv" and "BOOTH" are trademarks or registered trademarks of pixiv Inc. This tool's name deliberately avoids "BOOTH" to prevent confusion with official services. The `booth` server name, `booth_*` tool names, and `BOOTH_MCP_*` environment variables only describe the platform the tool works with.

自分の BOOTH アカウントの購入データ（ライブラリ・ギフト・無料ダウンロード・注文履歴・ほしいものリスト）と BOOTH の公開商品データを、**読み取り専用**で扱う MCP サーバー + CLI です（BOOTH 上のデータは変更しません。購入ファイルのダウンロードは[オプトイン](#ダウンロードオプトイン)です）。VRChat 向けに「持っている衣装のうち しなの 対応のものは？」「この商品は 桔梗 に対応してる？」に根拠付きで答えるための機能があります。

本プロジェクトは [cstria0106/booth-mcp](https://github.com/cstria0106/booth-mcp)（MIT License）のフォークです。原作者に感謝します。ライセンスは MIT で、原作者の著作権表示を残したうえでフォーク側の変更分の表示を加えています（[LICENSE](LICENSE)）。リポジトリ: https://github.com/tomo1560/avatar-closet-mcp

## できること・できないこと

- できること: ライブラリ・ギフト・無料ダウンロード・注文履歴・[ほしいものリスト](#ほしいものリストと無料ダウンロード)の一覧、注文詳細、商品詳細（公開 JSON）、商品検索、タグ候補、VRChat の対応アバター・依存ツール・Quest 対応の判定、購入品の[更新チェック](#更新チェック)（前回の確認からのダウンロードファイルの変化）、[Unity プロジェクトとの突き合わせ](#unity-プロジェクトとの突き合わせcli)（CLI）、購入したファイルのダウンロード（オプトイン・既定は無効）
- できないこと: 購入・カート・ウィッシュリストの変更など BOOTH 上のデータを変える操作（通信は GET のみ）、ストア全体の巡回
- 注文詳細の氏名・住所・電話番号・メールアドレスは取得・表示しません

## 必要なもの

- Node.js 20 以上
- ソースからビルドする場合: [Bun](https://bun.sh/)（1.3.14 で確認）と Git
- ログイン時のみ: Google Chrome または Microsoft Edge と、ブラウザ画面を表示できるデスクトップ環境

## インストール

> **npm にはまだ公開していません。** 今は GitHub から取得してビルドしてください。`npx -y avatar-closet-mcp` を使う手順（このページの CLI の例を含む）は npm 公開後のものです。公開前は `npx -y avatar-closet-mcp` を `node <abs>/dist/cli.js` に読み替えてください。

### GitHub から取得してビルドする

```bash
git clone https://github.com/tomo1560/avatar-closet-mcp
cd avatar-closet-mcp
bun install
bun run build
# Claude Code に登録（<abs> は clone したフォルダの絶対パスに置き換える）
claude mcp add booth -- node <abs>/dist/cli.js
# CLI として使う
node dist/cli.js login
node dist/cli.js library --all
```

Claude Desktop などでは `"command": "node"`, `"args": ["<abs>/dist/cli.js"]` を指定します。

### npm 公開後

Claude Code:

```bash
claude mcp add booth -- npx -y avatar-closet-mcp
```

Claude Desktop（`claude_desktop_config.json`）や Cursor などの MCP 設定:

```json
{
  "mcpServers": {
    "booth": {
      "command": "npx",
      "args": ["-y", "avatar-closet-mcp"]
    }
  }
}
```

Codex（プラグインを使わない場合）:

```toml
[mcp_servers.booth]
command = "npx"
args = ["-y", "avatar-closet-mcp"]
```

## ログイン

MCP クライアントから `booth_login` を呼ぶか、ターミナルで次を実行します。

```bash
npx -y avatar-closet-mcp login
```

専用プロファイルの Chrome / Edge が開くので、**自分で** pixiv アカウントでログインしてください。このツールはパスワードを読み取ったり自動入力したりしません（reCAPTCHA や二段階認証もそのままブラウザで操作します）。ログインが確認できるとセッション cookie が `session.json` に保存され、以降の問い合わせではブラウザを起動しません。

ブラウザは既定で Google Chrome / Microsoft Edge を自動検出します。見つからない場合は `BOOTH_MCP_BROWSER_PATH` に Chromium 系ブラウザの実行ファイルのパスを指定します。

## MCP ツール

| ツール | 入力 | 内容 | ログイン |
| --- | --- | --- | --- |
| `booth_login` | `timeout_sec?` | ブラウザで手動ログイン | — |
| `booth_auth_status` | — | ログイン状態 | — |
| `booth_logout` | — | 保存したセッションとログイン用プロファイルを削除 | — |
| `booth_get_item` | `item`（ID / URL）, `include_vrchat?` | 商品詳細（+ VRChat 情報） | 不要 |
| `booth_search_items` | `query`, `category?`, `tags?`, `sort?`, `page?`（1〜5）, `only_free?`, `adult?` | 商品検索 | 不要 |
| `booth_suggest_tags` | `term` | タグ候補 | 不要 |
| `booth_check_compatibility` | `item`, `avatar` | `supported` / `not_supported` / `unknown` + 根拠 | 不要 |
| `booth_search_for_avatar` | `avatar`, `kind?`（既定 costume）, `query?`, `page?`（1〜3） | アバター向け商品の検索。先頭 10 件に対応度 | 不要 |
| `booth_list_library` | `page?`, `all?`, `query?`, `avatar?`, `kind?`, `dependency?` | 購入した商品（ファイル名付き）。VRChat 条件で絞り込み可 | 要 |
| `booth_list_gifts` | 同上 | 受け取ったギフト | 要 |
| `booth_list_free_downloads` | 同上 | ライブラリの「無料ダウンロード」タブ（ファイル一覧は無し） | 要 |
| `booth_list_orders` | `page?` | 注文履歴 | 要 |
| `booth_get_order` | `order_id` | 注文詳細（商品・価格・ダウンロード ID） | 要 |
| `booth_list_my_avatars` | — | 所持アバター本体と辞書 | 要 |
| `booth_sync_library_metadata` | `max_items?`（既定 20、最大 100） | 購入品の商品データをキャッシュに取り込む | 要 |
| `booth_check_updates` | `item_ids?`（最大 100）, `avatar?` | 前回の確認からダウンロードファイル構成が変わった購入品（[更新チェック](#更新チェック)） | 要 |
| `booth_list_wishlist` | `page?`（1〜50）, `list?`（コードか名前）, `all?`, `include_vrchat?` | ほしいものリスト（スキ！した商品）。価格・売り切れ・BOOTH の VRChat フラグ。`include_vrchat` で対応アバター判定（[ほしいものリスト](#ほしいものリストと無料ダウンロード)） | 要 |
| `booth_list_wishlist_names` | — | 名前付きのほしいものリスト（コードと名前） | 要 |
| `booth_download` | `downloadable_id`, `variation_id?`, `dest_subdir?` | 購入したファイルを保存。**オプトイン**（有効にしたときだけ表示） | 要 |

結果は `{ _notice, data, meta }` 形式の JSON です（`_notice` は BOOTH 側の文字列を信用しないよう促す注意書き）。失敗時は `{ _notice, error: { code, message } }` になります（[エラーコード](#エラーコードと終了コード)）。続きがある一覧は `meta.nextPage`、商品データが未取得の件数は `metadata_pending` / `remaining` で示します。`all=true` は最大 20 ページで打ち切ります。

ツールは既定で 18 個、[ダウンロード](#ダウンロードオプトイン)を有効にすると `booth_download` が加わって 19 個です。

### `booth_get_item` の `viewer`（ログイン中の状態）

`viewer` は、ログイン中にその呼び出しで BOOTH から取得した商品データ（`items/{id}.json`）にだけ付きます。ログアウト中や閲覧者固有の状態が無いときは `null` です。

- `owned_variation_ids`: BOOTH がログイン中の購入者に `status: "already_bought_digital"` で返すバリエーションの ID（購入したバリエーション）。その呼び出しの取得結果からだけ作り、キャッシュからは作りません。BOOTH に接続できずキャッシュを返した結果（`stale: true`）では `viewer` は `null` で、これは「所有状態が不明」という意味です（未購入という意味ではありません）。
- 受け取ったギフトにはこの状態が付かず、購入品でも付かないものがありました（2026-10 確認）。空の配列は未所有の証明にならないため、所有の確認には `booth_list_library` / `booth_list_gifts` を使ってください。
- `wished`: ほしいものリスト（スキ！）に入っているか。
- `ordered` / `gifted`: BOOTH の `order` / `gift` から作りますが、購入済みの商品や受け取ったギフトでも常に `null` だったため（2026-10 確認）実質的に常に `false` です。所有の判定には使いません。

## CLI

MCP と同じ処理を CLI からも使えます。既定は表形式、`--json` で MCP と同じ JSON を出力します。

```bash
npx -y avatar-closet-mcp library [--all] [--page N] [--query Q] [--avatar A] [--kind K] [--dependency D] [--json]
npx -y avatar-closet-mcp gifts   （library と同じオプション）
npx -y avatar-closet-mcp free    （library と同じオプション。無料ダウンロードのタブ）
npx -y avatar-closet-mcp wishlist [--page N] [--list <コード|名前>] [--all] [--vrchat] [--json]
npx -y avatar-closet-mcp wishlist names [--json]
npx -y avatar-closet-mcp orders [--page N] [--json]
npx -y avatar-closet-mcp order <注文ID> [--json]
npx -y avatar-closet-mcp item <商品ID|URL> [--vrchat] [--json]
npx -y avatar-closet-mcp search <検索語> [--category C] [--tag T]... [--sort S] [--page N] [--free] [--adult] [--json]
npx -y avatar-closet-mcp tags <語> [--json]
npx -y avatar-closet-mcp compat <商品ID|URL> <アバター> [--json]
npx -y avatar-closet-mcp avatars [init] [--json]
npx -y avatar-closet-mcp sync [--max N] [--json]
npx -y avatar-closet-mcp download <ダウンロードID> [--variation N] [--out <dir>] [--json]   （オプトイン）
npx -y avatar-closet-mcp updates [--item <商品ID>]... [--avatar A] [--json]
npx -y avatar-closet-mcp unity-check <Unityプロジェクトのフォルダ> [--json]
npx -y avatar-closet-mcp login [--timeout <秒>] | status [--json] | logout | serve | help
```

`login` の `--timeout` は 30〜1800 秒（既定 600）。`status` は未ログインのとき終了コード 1 を返します（[終了コード](#エラーコードと終了コード)）。

例: `library --all --avatar しなの --kind costume`（しなの対応の衣装）、`compat https://booth.pm/ja/items/123456 桔梗`。

`sync` はライブラリを 1 回読み込んだあと、未取得の商品データを 20 件ずつ取り込みます。`--max N` は 1 回の実行で送る商品データのリクエスト数の上限です（失敗も数えます。既定・最大 2000）。

`wishlist` は `booth_list_wishlist`（`--vrchat` が `include_vrchat`）、`wishlist names` は `booth_list_wishlist_names` と同じ処理です。例: `wishlist --list 衣装候補 --all --vrchat`。

`updates` は `booth_check_updates` と同じ処理です（`--item` は繰り返し指定できます）。例: `updates --avatar しなの`（しなの対応の購入品で更新があったもの）。`unity-check` は[後述](#unity-プロジェクトとの突き合わせcli)。

## ほしいものリストと無料ダウンロード

- **ほしいものリスト**（`booth_list_wishlist` / CLI `wishlist`）: `accounts.booth.pm/wish_list_name_items.json`（1 ページ 20 件）を GET で読みます。`all` は最大 20 ページで打ち切ります（`truncated`）。`list` に名前付きリストのコードか名前を指定すると、`wish_list_names.json` を 1 回読んでリストを特定し、そのリストだけを返します（見つからないときは `INVALID_INPUT` で、あるリストの名前とコードを示します）。リストの一覧は `booth_list_wishlist_names` / `wishlist names` です。リストへの追加・削除はしません（読み取り専用）。
- 各商品は商品 ID・名前・URL・ショップ・価格（BOOTH の表示文字列。`~` はバリエーションによる最低価格）・カテゴリ・成人向け / 売り切れ / 販売終了の別と、BOOTH 自身の VRChat フラグ `is_vrchat`（出品者の設定で、対応判定ではありません）です。
- `include_vrchat` を付けると商品データ（キャッシュ優先、1 回あたり最大 20 件取得）から根拠付きの対応アバター・依存ツール（`vrchat`）を付けます。ほしいものリストの商品は `sync` の対象外なので、`metadata_pending` が残ったときは同じ条件でもう一度呼ぶと続きを取得します。
- **無料ダウンロード**（`booth_list_free_downloads` / CLI `free`）: ライブラリの「無料ダウンロード」タブです。入力と出力はライブラリと同じですが、このタブにはファイルの一覧が無いため `downloadables` は常に空です（ファイルは商品ページから入手します）。
- 所持品をまとめて読む処理のうち、`booth_list_my_avatars`・`avatars init`・`booth_sync_library_metadata` / `sync`・`unity-check` は無料ダウンロードも含みます（そのぶんタブのページ数だけリクエストが増えます）。`booth_check_updates` / `updates` は比べるファイルが無いので含めず、これまでどおりライブラリとギフトだけを比べます（既存の基準もそのまま使えます）。

## 更新チェック

`booth_check_updates`（CLI は `updates`）は、ライブラリとギフトの全ページを読み、購入品ごとのダウンロードファイル（ダウンロード ID とファイル名）を **前回の確認** のときの記録（基準）と比べます。

- 返すもの: ファイルが追加・削除・改名された商品（`changed`。`added_files` は新しいバージョンのアップロードであることが多い）、新しい購入品（`new_items`）、一覧から消えた商品（`removed_items`）、変化の無い件数（`unchanged_count`）、比べた基準の日時（`previous_snapshot_taken_at`）。
- **初回** は比較対象が無いので、現在の一覧を基準として記録するだけです（`first_run: true`）。2 回目以降は前回の確認との差分を返し、今回の一覧が次回の基準になります。`sync` や `booth_list_my_avatars` は基準を進めません（キャッシュ用の記録は別ファイルです）。
- `item_ids` を指定するとその商品だけを確認し、基準もその商品の分だけ更新します（他の商品の変化は次回も報告されます）。
- `avatar` を指定すると、変化した商品・新しい購入品のうち、そのアバターに対応する（根拠付きで `supported` の）ものだけを返します（例: 「しなの対応の購入品で更新があったもの」）。商品データはキャッシュ優先で 1 回あたり最大 20 件取得し（ファイルが変わった商品は再取得）、未取得の件数は `metadata_pending` です。対応と判定できなかった商品の変化は基準を進めないので、`avatar` なしの確認で後から確認できます。
- ライブラリかギフトが 20 ページを超えて全件を読めないときは、読めなかった商品が消えたように見えてしまうため、比較も基準の記録もせず `complete: false` と警告を返します。
- 基準は `cache/library-snapshot.json` に保存します（BOOTH には GET しかせず、書き込むのはこのローカルファイルだけです）。削除すると次回は初回扱いになります。書き込めなかったときは結果の `warnings` に理由が入ります（`snapshot_saved: false`）。
- ライブラリの一覧は同じプロセス内で最大 5 分間再利用します。

## Unity プロジェクトとの突き合わせ（CLI）

```bash
npx -y avatar-closet-mcp unity-check "D:/Unity/MyAvatar"
npx -y avatar-closet-mcp unity-check ./MyAvatarProject --json
```

- Unity プロジェクトの `Assets/` のフォルダ名（2 階層まで）と `Packages/vpm-manifest.json` / `Packages/manifest.json` だけを読み、ライブラリとギフトの商品名・ダウンロードファイル名、無料ダウンロードの商品名と照合します。アセットの中身は読みません。
- 結果は一致した購入品の表（商品 ID・商品名・一致の種類 `matched_by`（ファイル名 / フォルダ名 / VPM）・確度 `confidence`・根拠 `evidence`）と、購入品と一致しなかったフォルダの一覧です。フォルダ名からの推定なので、確度が low / medium のものは中身で確認してください。
- `Packages/manifest.json` のうちローカルパス（`file:…`）は `local`、git の URL は `git` と表示し、パスや URL そのものは出力しません。
- これは CLI だけの機能です（MCP ツールはありません）。Claude などから使う場合は、`booth_list_library`（購入品のファイル名）と Unity 用の MCP サーバー（プロジェクトのフォルダやパッケージを読めるもの）を組み合わせて「このプロジェクトに入っている購入品は？」と聞くこともできます。

## VRChat 向け機能と限界

- 対応アバターは商品データ（`items/{id}.json`）の **バリエーション名・タグ・「対応アバター」見出し・商品名・説明文** と、購入品の **ダウンロードファイル名** から抽出し、`confidence`（high / medium / low）と `evidence`（該当箇所の引用）を付けます。
- **推測はしません。** 根拠が見つからなければ `unknown` です。「〇〇には非対応」などの否定表現は `not_supported` になります。判定はヒューリスティックなので、最終確認は商品ページで行ってください。
- `kind` は BOOTH のカテゴリから `avatar` / `costume` / `accessory` / `tool` / `motion` / `other` に分類します。
- 依存ツール（lilToon, Poiyomi, Modular Avatar, VRCFury, Avatar Optimizer, NDMF など）と Quest 対応（`yes` / `no` / `unknown`）も同様に根拠付きで返します。
- ライブラリの絞り込み（`avatar` / `kind` / `dependency`）や `booth_list_my_avatars` は、購入品ごとの商品データが必要です。1 回の呼び出しで取得するのは最大 20 件なので、購入品が多い場合は先に `npx -y avatar-closet-mcp sync` で取り込んでおくと速く答えられます。

## ダウンロード（オプトイン）

購入したファイルの保存は **既定で無効** です。次の両方を設定したときだけ、MCP ツール `booth_download` が現れ、CLI の `download` が使えます。

| 環境変数 | 内容 |
| --- | --- |
| `BOOTH_MCP_ENABLE_DOWNLOAD` | `1` で有効。未設定・それ以外は無効（既定: 無効） |
| `BOOTH_MCP_DOWNLOAD_DIR` | 保存先の **絶対パス**（有効化するときは必須）。ファイルはこの中にだけ保存します（無ければ作成） |
| `BOOTH_MCP_DOWNLOAD_HOSTS` | 任意。ダウンロード先として許可するホストのカンマ区切り（`s6.booth.pm` や `*.booth.pm`）。既定: `*.booth.pm`。`*.booth.pm` は `booth.pm` 自体を含まないサブドメインだけを許可します |
| `BOOTH_MCP_DOWNLOAD_MAX_BYTES` | 任意。1 ファイルの上限バイト数（既定: 4 GiB = 4294967296。`0` で上限なし）。超えたら中止して一時ファイルを削除 |
| `BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC` | 任意。1〜86400 の秒数。設定すると下記の 2 つの待ち時間の **両方** をこの値にします（未設定: 応答ヘッダーは 30 秒、データの途切れは 60 秒） |

不正な値（相対パスの保存先、範囲外の数値、不正なホスト名など）があると、ダウンロードは無効のままになり、理由を起動時に標準エラーへ 1 回だけ出力します（fail closed）。

```json
{
  "mcpServers": {
    "booth": {
      "command": "npx",
      "args": ["-y", "avatar-closet-mcp"],
      "env": { "BOOTH_MCP_ENABLE_DOWNLOAD": "1", "BOOTH_MCP_DOWNLOAD_DIR": "D:\\BOOTH" }
    }
  }
}
```

- `downloadable_id` は `booth_get_order` / `booth_list_library` の結果に含まれます。
- `dest_subdir` は保存先の中のサブフォルダ（相対パス）です。絶対パスや、保存先の外へ出る指定（`..`、シンボリックリンク・ジャンクションの先が外になる場合）は拒否します。各フォルダ名は次の条件を満たす必要があります: `..` ではない、`:` を含まない、`<>"/\|?*` や制御文字・双方向制御文字を含まない、Windows の予約名（CON・NUL・COM1・LPT1 など）ではない、末尾が `.` や空白ではない、UTF-8 で 200 バイト以内。条件に合わないときは何も作らずに `INVALID_INPUT` を返します。
- 失敗の種類ごとのエラーコードは[エラーコードと終了コード](#エラーコードと終了コード)を参照してください（保存先の外の指定・同名ファイル・上限超過などは `INVALID_INPUT`、OS のファイル操作の失敗は `INTERNAL_ERROR`）。
- `booth.pm/downloadables/{id}` をログイン済みセッションで 1 回だけ GET し、リダイレクト先（短時間だけ有効な署名付き URL）を **cookie を送らずに** 取得します。リダイレクト先が `https` かつ許可ホストでなければ拒否します（さらに 1 回までのリダイレクトも同じ検査をします）。
- **既存のファイルは上書きしません。** 同名のファイルがあればエラーになります（移動・削除するか `dest_subdir` を変えてください）。ダウンロード中は `<ファイル名>.part` に書き、失敗したら削除します。
- ファイル名は Content-Disposition かリダイレクト先 URL の末尾から取り、パス区切り・`..`・制御文字・Windows の予約名などを取り除きます。
- 署名付き URL はログ・エラー・結果のどこにも出しません。
- 設定が不正なとき（`BOOTH_MCP_ENABLE_DOWNLOAD=1` なのに保存先が未設定・相対パスなど）は、`booth_download` を登録せず、理由を起動時に標準エラーへ 1 回だけ出力します。
- CLI でも `BOOTH_MCP_ENABLE_DOWNLOAD=1` が必要です（確認を省くフラグはありません）。`--out <dir>` はその実行に限り `BOOTH_MCP_DOWNLOAD_DIR` の代わりに使う保存先で、相対パスはカレントディレクトリ基準です。

```bash
BOOTH_MCP_ENABLE_DOWNLOAD=1 npx -y avatar-closet-mcp download 1234567 --out ./booth
```

**自分が購入・受け取りしたファイル専用です。** 一度に大量のダウンロードはしないでください（pixiv の利用規約は過度な負荷や機械的な大量操作を禁じています）。保存したファイルの扱い（再配布の禁止など）は各商品の利用規約に従ってください。

## アバター辞書（avatars.json）

組み込みの辞書（しなの・桔梗・マヌカなど）に、ユーザーの `avatars.json` を重ねて使います（同じ `id` はユーザー側が優先）。

```json
{
  "version": 1,
  "avatars": [
    { "id": "shinano", "names": ["しなの", "Shinano", "シナノ"] },
    { "id": "my_avatar", "names": ["マイアバター", "MyAvatar"], "restricted": true }
  ]
}
```

- `names` は先頭が正式名、残りが別名です。`restricted: true` は一般名詞と紛らわしい名前（萌・ライムなど）を、タグ・バリエーション名・「対応アバター」見出しの中と「〇〇用」「〇〇対応」のような書き方のときだけ照合します（`restricted_names` で別名ごとの指定も可）。
- `npx -y avatar-closet-mcp avatars init` は、ライブラリにあるアバター本体のうち辞書に無いものを avatars.json に追記します。既存のエントリは変更しません。追記後に別名を手で足してください（ファイルは `{ "version": 1, "avatars": [...] }` 形式で書き直され、`id` / `names` / `restricted` / `restricted_names` 以外のキーは残りません）。
- 辞書の変更は次の呼び出しから反映されます（判定結果は保存しません）。

## キャッシュ

- 商品データは `cache/items/{商品ID}.json` に保存し、7 日間はキャッシュから使います。削除・非公開の商品（404）も同じ期間は再取得しません（`cache/unavailable-items.json`）。
- 期間は環境変数 `BOOTH_MCP_CACHE_TTL_DAYS`（日数。`0.04`〜`365`、小数可。既定 `7`）で変更できます。値が不正なときはサーバーを止めずに既定の 7 日を使い、起動時に標準エラーへ警告を 1 回出します。
- ライブラリとギフトを全ページ読んだとき（`sync`・`booth_list_my_avatars` など）、前回からダウンロードファイルの構成が変わった商品は、キャッシュが新しくても優先して再取得します（記録は `cache/item-cache-snapshot.json`。ページ数の上限で打ち切った一覧は記録しません）。
- `booth_get_item` は明示的な問い合わせなので常に BOOTH から取得します。BOOTH に制限された（`RATE_LIMITED`）・接続できない（`NETWORK_ERROR`）ときだけ、キャッシュがあればそれを `stale: true` と取得日時 `fetched_at` 付きで返します。
- 2 MiB を超えるキャッシュファイルは読み込まず、壊れたものとして扱って再取得します。
- キャッシュには公開データのみを保存し、ログイン中のお気に入り・購入状態などは保存しません。購入済みバリエーションの `already_bought_digital`（`already_bought` で始まる状態すべて）はログアウト時と同じ `addable_to_cart` に戻して保存し、この処理より前に書かれたキャッシュファイルも読み込み時に同じように戻します。そのためキャッシュから返す結果（`stale: true`）の `viewer` は常に `null` です。

## レート制限と利用規約への配慮

- pixiv の利用規約（サーバーへの過度な負荷、機械的な大量操作の禁止）に配慮し、BOOTH へのリクエストはすべて **直列・1 秒に 1 回以下** にしています。429 / 503 は指数バックオフで最大 3 回まで再試行し、それでも失敗すると `RATE_LIMITED` を返します。
- 扱うのは **自分のアカウントのデータ** と、ユーザーが明示的に指定した商品・検索だけです。カタログ全体を巡回する機能はありません（検索は 1 回 1 ページ、最大 5 ページ目まで）。
- 通信は GET のみで、BOOTH 上のデータは変更しません。

## データの保存場所

既定の保存先（`BOOTH_MCP_HOME` で変更可）:

| OS | 場所 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\avatar-closet-mcp` |
| macOS | `~/Library/Application Support/avatar-closet-mcp` |
| Linux | `$XDG_CONFIG_HOME/avatar-closet-mcp`（既定 `~/.config/avatar-closet-mcp`） |

| ファイル | 内容 | 個別に変更する環境変数 |
| --- | --- | --- |
| `session.json` | BOOTH のセッション cookie（共有・コミットしないでください） | `BOOTH_MCP_SESSION_FILE` |
| `browser-profile/` | ログイン用ブラウザプロファイル（pixiv の cookie を含む） | `BOOTH_MCP_PROFILE_DIR` |
| `cache/` | 商品データのキャッシュ（`items/{商品ID}.json`）、再取得を待つ商品の記録（`unavailable-items.json`）、更新チェックの基準（`library-snapshot.json`）、キャッシュ用のファイル構成の記録（`item-cache-snapshot.json`） | `BOOTH_MCP_CACHE_DIR` |
| `avatars.json` | ユーザーのアバター辞書 | `BOOTH_MCP_AVATARS_FILE` |

既定の場所はすべて `<アプリディレクトリ>` 直下です（`session.json`・`browser-profile/`・`cache/`・`avatars.json`）。`BOOTH_MCP_HOME` を変えるとこれらがまとめて移動します。

### セッションとブラウザプロファイル

- `session.json` は常に `<アプリディレクトリ>/session.json` に保存され、`BOOTH_MCP_PROFILE_DIR` を指定してもその隣には作られません。場所を変えるときは `BOOTH_MCP_SESSION_FILE` を指定してください。
- **`logout` が削除するブラウザプロファイルは限定されています。** `avatar-closet-mcp-profile.json`（ログイン時に本ツールが作成したプロファイルに付くマーカー）があるものだけを削除します。カスタムの `BOOTH_MCP_PROFILE_DIR` の場合は、さらに Chromium のプロファイルらしい（`Local State` か `Default/` がある）ことも必要です。マーカーが無いプロファイル（別の方法で作ったものなど）は削除されず、警告が出ます。その場合は手動で削除してください（pixiv の cookie を含むため）。

## 環境変数一覧

ソースコードが読む `BOOTH_MCP_*` の一覧です。すべて任意で、未設定なら既定値を使います。

| 環境変数 | 既定値 | 内容 |
| --- | --- | --- |
| `BOOTH_MCP_HOME` | OS ごとのアプリディレクトリ（[データの保存場所](#データの保存場所)） | 保存先の基準フォルダ |
| `BOOTH_MCP_SESSION_FILE` | `<アプリディレクトリ>/session.json` | セッション cookie の場所 |
| `BOOTH_MCP_PROFILE_DIR` | `<アプリディレクトリ>/browser-profile` | ログイン用ブラウザプロファイル |
| `BOOTH_MCP_BROWSER_PATH` | 自動検出（Chrome / Edge） | ログイン用ブラウザの実行ファイル |
| `BOOTH_MCP_CACHE_DIR` | `<アプリディレクトリ>/cache` | 商品データ・更新チェックの記録 |
| `BOOTH_MCP_CACHE_TTL_DAYS` | `7`（`0.04`〜`365`） | 商品データのキャッシュ期間（日） |
| `BOOTH_MCP_AVATARS_FILE` | `<アプリディレクトリ>/avatars.json` | アバター辞書 |
| `BOOTH_MCP_ENABLE_DOWNLOAD` | 無効 | `1` でダウンロード機能を有効にする（[ダウンロード](#ダウンロードオプトイン)） |
| `BOOTH_MCP_DOWNLOAD_DIR` | 未設定（有効化時は必須） | 保存先の絶対パス |
| `BOOTH_MCP_DOWNLOAD_HOSTS` | `*.booth.pm` | 許可するダウンロード先ホスト |
| `BOOTH_MCP_DOWNLOAD_MAX_BYTES` | `4294967296`（4 GiB）。`0` は上限なし | 1 ファイルの上限バイト数 |
| `BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC` | 応答ヘッダー 30 秒・データ途切れ 60 秒 | 設定すると両方をこの秒数にする（1〜86400） |

## ログアウト

```bash
npx -y avatar-closet-mcp logout
```

`session.json` と、マーカー付きのログイン用ブラウザプロファイルを削除します（BOOTH には通信しません）。マーカーの無いプロファイルは削除せず、手動での削除を案内します（[詳細](#セッションとブラウザプロファイル)）。キャッシュと avatars.json は残るので、不要なら保存先のフォルダごと削除してください。

## エラーコードと終了コード

### MCP ツールのエラーコード

失敗したツールは `{ _notice, error: { code, message } }` を返します。`message` に含まれるのは利用者向けの説明だけで、ローカルのパス・cookie・署名付き URL は含みません。

| コード | 意味 | 対処 |
| --- | --- | --- |
| `AUTH_REQUIRED` | BOOTH にログインしていない、またはセッションが切れた | `booth_login`（CLI は `login`）でログインし、もう一度実行する |
| `NOT_FOUND` | 商品・注文・ダウンロードが見つからない（削除・非公開を含む） | ID や URL が正しいか確認する。削除・非公開の商品は取得できません |
| `BOOTH_CHANGED` | BOOTH のページ構造・データ形式・リダイレクトが想定と違う。ダウンロードでは許可リスト外のホストへのリダイレクトも含む | BOOTH 側の変更の可能性が高い。しばらく待って再実行し、続く場合は報告してください。ダウンロードで許可リスト外のホストが理由なら、信頼できる場合のみ `BOOTH_MCP_DOWNLOAD_HOSTS` に追加できます |
| `RATE_LIMITED` | BOOTH に制限された（429 / 503 が再試行後も続いた） | 時間をおいてから再実行する。キャッシュがあれば `booth_get_item` は `stale: true` 付きで返します |
| `NETWORK_ERROR` | 通信できない、タイムアウト、ダウンロードが途中で切れた | ネットワークを確認して再実行する |
| `INVALID_INPUT` | 入力が不正。ダウンロードでは保存先の外の指定、同名ファイルや `.part` の存在、`dest_subdir` の不正、上限サイズ超過、ダウンロードの無効な設定を含む | 引数・環境変数を直す。同名ファイルは移動か削除をするか、`dest_subdir` を変える |
| `INTERNAL_ERROR` | 本ツール内部のエラー、または OS のファイル操作の失敗（権限・空き容量など） | ローカルファイルの場合は message の errno コード（例: `EACCES`、`ENOSPC`）だけが示されます。保存先の権限・空き容量・ファイルの状態を確認する。再現する場合は報告する |

ローカルのファイル操作の失敗は `INTERNAL_ERROR` になり、message にはパスは含まれず errno コードだけが入ります（パスには OS のユーザー名が含まれるため）。

### CLI の終了コード

| 終了コード | 意味 | 対応するエラーコード |
| --- | --- | --- |
| `0` | 成功 | — |
| `1` | `status`: 未ログイン（`status` だけが返す値） | — |
| `2` | 入力・使い方の誤り、無効な設定 | `INVALID_INPUT` |
| `3` | ログインが必要 | `AUTH_REQUIRED` |
| `4` | 見つからない | `NOT_FOUND` |
| `5` | BOOTH による制限中 | `RATE_LIMITED` |
| `6` | 通信エラー | `NETWORK_ERROR` |
| `7` | BOOTH の仕様変更の可能性 | `BOOTH_CHANGED` |
| `8` | 内部エラー・ローカルファイルの操作失敗、その他（想定外の例外も含む） | `INTERNAL_ERROR` |

`avatar-closet-mcp help` の出力末尾にも同じ終了コードの一覧があります。

## 開発

```bash
bun install
bun run lint && bun run typecheck && bun run test && bun run build
```

`bun run test:live` は実際の BOOTH アカウントに通信するため、明示的に必要なときだけ手動で実行してください。
