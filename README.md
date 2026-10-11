# booth-library-mcp

> [!IMPORTANT]
> **非公式ツールです。pixiv / BOOTH とは一切関係ありません。** BOOTH の画面構造が変わると一部の機能が動かなくなることがあります。

自分の BOOTH アカウントの購入データ（ライブラリ・ギフト・注文履歴）と BOOTH の公開商品データを、**読み取り専用**で扱う MCP サーバー + CLI です（BOOTH 上のデータは変更しません。購入ファイルのダウンロードは[オプトイン](#ダウンロードオプトイン)です）。VRChat 向けに「持っている衣装のうち しなの 対応のものは？」「この商品は 桔梗 に対応してる？」に根拠付きで答えるための機能があります。

本プロジェクトは [cstria0106/booth-mcp](https://github.com/cstria0106/booth-mcp)（MIT License）のフォークです。原作者に感謝します。ライセンスは MIT です（[LICENSE](LICENSE)）。

## できること・できないこと

- できること: ライブラリ・ギフト・注文履歴の一覧、注文詳細、商品詳細（公開 JSON）、商品検索、タグ候補、VRChat の対応アバター・依存ツール・Quest 対応の判定、購入したファイルのダウンロード（オプトイン・既定は無効）
- できないこと: 購入・カート・ウィッシュリストの変更など BOOTH 上のデータを変える操作（通信は GET のみ）、ストア全体の巡回
- 注文詳細の氏名・住所・電話番号・メールアドレスは取得・表示しません

## 必要なもの

- Node.js 20 以上
- ログイン時のみ: Google Chrome または Microsoft Edge と、ブラウザ画面を表示できるデスクトップ環境

## インストール

Claude Code:

```bash
claude mcp add booth -- npx -y booth-library-mcp
```

Claude Desktop（`claude_desktop_config.json`）や Cursor などの MCP 設定:

```json
{
  "mcpServers": {
    "booth": {
      "command": "npx",
      "args": ["-y", "booth-library-mcp"]
    }
  }
}
```

Codex（プラグインを使わない場合）:

```toml
[mcp_servers.booth]
command = "npx"
args = ["-y", "booth-library-mcp"]
```

## ログイン

MCP クライアントから `booth_login` を呼ぶか、ターミナルで次を実行します。

```bash
npx -y booth-library-mcp login
```

専用プロファイルの Chrome / Edge が開くので、**自分で** pixiv アカウントでログインしてください。このツールはパスワードを読み取ったり自動入力したりしません（reCAPTCHA や二段階認証もそのままブラウザで操作します）。ログインが確認できるとセッション cookie が `session.json` に保存され、以降の問い合わせではブラウザを起動しません。

ブラウザが見つからない場合は `BOOTH_MCP_BROWSER_PATH` に実行ファイルのパスを指定します。

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
| `booth_list_orders` | `page?` | 注文履歴 | 要 |
| `booth_get_order` | `order_id` | 注文詳細（商品・価格・ダウンロード ID） | 要 |
| `booth_list_my_avatars` | — | 所持アバター本体と辞書 | 要 |
| `booth_sync_library_metadata` | `max_items?`（既定 20、最大 100） | 購入品の商品データをキャッシュに取り込む | 要 |
| `booth_download` | `downloadable_id`, `variation_id?`, `dest_subdir?` | 購入したファイルを保存。**オプトイン**（有効にしたときだけ表示） | 要 |

結果は `{ data, meta }` 形式の JSON です。続きがある一覧は `meta.nextPage`、商品データが未取得の件数は `metadata_pending` / `remaining` で示します。`all=true` は最大 20 ページで打ち切ります。

## CLI

MCP と同じ処理を CLI からも使えます。既定は表形式、`--json` で MCP と同じ JSON を出力します。

```bash
npx -y booth-library-mcp library [--all] [--page N] [--query Q] [--avatar A] [--kind K] [--dependency D] [--json]
npx -y booth-library-mcp gifts   （library と同じオプション）
npx -y booth-library-mcp orders [--page N] [--json]
npx -y booth-library-mcp order <注文ID> [--json]
npx -y booth-library-mcp item <商品ID|URL> [--vrchat] [--json]
npx -y booth-library-mcp search <検索語> [--category C] [--tag T]... [--page N] [--json]
npx -y booth-library-mcp tags <語>
npx -y booth-library-mcp compat <商品ID|URL> <アバター> [--json]
npx -y booth-library-mcp avatars [--json]
npx -y booth-library-mcp avatars init
npx -y booth-library-mcp sync [--max N]
npx -y booth-library-mcp download <ダウンロードID> [--variation N] [--out <dir>] [--json]   （オプトイン）
npx -y booth-library-mcp login | status | logout | serve | help
```

例: `library --all --avatar しなの --kind costume`（しなの対応の衣装）、`compat https://booth.pm/ja/items/123456 桔梗`。

`sync` はライブラリを 1 回読み込んだあと、未取得の商品データを 20 件ずつ取り込みます。`--max N` は 1 回の実行で送る商品データのリクエスト数の上限です（失敗も数えます。既定・最大 2000）。

## VRChat 向け機能と限界

- 対応アバターは商品データ（`items/{id}.json`）の **バリエーション名・タグ・「対応アバター」見出し・商品名・説明文** と、購入品の **ダウンロードファイル名** から抽出し、`confidence`（high / medium / low）と `evidence`（該当箇所の引用）を付けます。
- **推測はしません。** 根拠が見つからなければ `unknown` です。「〇〇には非対応」などの否定表現は `not_supported` になります。判定はヒューリスティックなので、最終確認は商品ページで行ってください。
- `kind` は BOOTH のカテゴリから `avatar` / `costume` / `accessory` / `tool` / `motion` / `other` に分類します。
- 依存ツール（lilToon, Poiyomi, Modular Avatar, VRCFury, Avatar Optimizer, NDMF など）と Quest 対応（`yes` / `no` / `unknown`）も同様に根拠付きで返します。
- ライブラリの絞り込み（`avatar` / `kind` / `dependency`）や `booth_list_my_avatars` は、購入品ごとの商品データが必要です。1 回の呼び出しで取得するのは最大 20 件なので、購入品が多い場合は先に `npx -y booth-library-mcp sync` で取り込んでおくと速く答えられます。

## ダウンロード（オプトイン）

購入したファイルの保存は **既定で無効** です。次の両方を設定したときだけ、MCP ツール `booth_download` が現れ、CLI の `download` が使えます。

| 環境変数 | 内容 |
| --- | --- |
| `BOOTH_MCP_ENABLE_DOWNLOAD` | `1` で有効（それ以外は無効） |
| `BOOTH_MCP_DOWNLOAD_DIR` | 保存先の **絶対パス**。ファイルはこの中にだけ保存します（無ければ作成） |
| `BOOTH_MCP_DOWNLOAD_HOSTS` | 任意。ダウンロード先として許可するホストのカンマ区切り（`s6.booth.pm` や `*.booth.pm`）。既定は `*.booth.pm` |
| `BOOTH_MCP_DOWNLOAD_MAX_BYTES` | 任意。1 ファイルの上限バイト数（超えたら中止して一時ファイルを削除） |

```json
{
  "mcpServers": {
    "booth": {
      "command": "npx",
      "args": ["-y", "booth-library-mcp"],
      "env": { "BOOTH_MCP_ENABLE_DOWNLOAD": "1", "BOOTH_MCP_DOWNLOAD_DIR": "D:\\BOOTH" }
    }
  }
}
```

- `downloadable_id` は `booth_get_order` / `booth_list_library` の結果に含まれます。`dest_subdir` は保存先の中のサブフォルダ（相対パス）で、外側は指定できません。
- `booth.pm/downloadables/{id}` をログイン済みセッションで 1 回だけ GET し、リダイレクト先（短時間だけ有効な署名付き URL）を **cookie を送らずに** 取得します。リダイレクト先が `https` かつ許可ホストでなければ拒否します（さらに 1 回までのリダイレクトも同じ検査をします）。
- **既存のファイルは上書きしません。** 同名のファイルがあればエラーになります（移動・削除するか `dest_subdir` を変えてください）。ダウンロード中は `<ファイル名>.part` に書き、失敗したら削除します。
- ファイル名は Content-Disposition かリダイレクト先 URL の末尾から取り、パス区切り・`..`・制御文字・Windows の予約名などを取り除きます。
- 署名付き URL はログ・エラー・結果のどこにも出しません。
- 設定が不正なとき（`BOOTH_MCP_ENABLE_DOWNLOAD=1` なのに保存先が未設定・相対パスなど）は、`booth_download` を登録せず、理由を起動時に標準エラーへ 1 回だけ出力します。
- CLI でも `BOOTH_MCP_ENABLE_DOWNLOAD=1` が必要です（確認を省くフラグはありません）。`--out <dir>` はその実行に限り `BOOTH_MCP_DOWNLOAD_DIR` の代わりに使う保存先で、相対パスはカレントディレクトリ基準です。

```bash
BOOTH_MCP_ENABLE_DOWNLOAD=1 npx -y booth-library-mcp download 1234567 --out ./booth
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
- `npx -y booth-library-mcp avatars init` は、ライブラリにあるアバター本体のうち辞書に無いものを avatars.json に追記します。既存のエントリは変更しません。追記後に別名を手で足してください（ファイルは `{ "version": 1, "avatars": [...] }` 形式で書き直され、`id` / `names` / `restricted` / `restricted_names` 以外のキーは残りません）。
- 辞書の変更は次の呼び出しから反映されます（判定結果は保存しません）。

## キャッシュ

- 商品データは `cache/items/{商品ID}.json` に保存し、7 日間はキャッシュから使います。削除・非公開の商品（404）も 7 日間は再取得しません（`cache/unavailable-items.json`）。
- キャッシュには公開データのみを保存し、ログイン中のお気に入り・購入状態などは保存しません。

## レート制限と利用規約への配慮

- pixiv の利用規約（サーバーへの過度な負荷、機械的な大量操作の禁止）に配慮し、BOOTH へのリクエストはすべて **直列・1 秒に 1 回以下** にしています。429 / 503 は指数バックオフで最大 3 回まで再試行し、それでも失敗すると `RATE_LIMITED` を返します。
- 扱うのは **自分のアカウントのデータ** と、ユーザーが明示的に指定した商品・検索だけです。カタログ全体を巡回する機能はありません（検索は 1 回 1 ページ、最大 5 ページ目まで）。
- 通信は GET のみで、BOOTH 上のデータは変更しません。

## データの保存場所

既定の保存先（`BOOTH_MCP_HOME` で変更可）:

| OS | 場所 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\booth-library-mcp` |
| macOS | `~/Library/Application Support/booth-library-mcp` |
| Linux | `$XDG_CONFIG_HOME/booth-library-mcp`（既定 `~/.config/booth-library-mcp`） |

| ファイル | 内容 | 個別に変更する環境変数 |
| --- | --- | --- |
| `session.json` | BOOTH のセッション cookie（共有・コミットしないでください） | `BOOTH_MCP_SESSION_FILE` |
| `browser-profile/` | ログイン用ブラウザプロファイル（pixiv の cookie を含む） | `BOOTH_MCP_PROFILE_DIR` |
| `cache/` | 商品データのキャッシュ | `BOOTH_MCP_CACHE_DIR` |
| `avatars.json` | ユーザーのアバター辞書 | `BOOTH_MCP_AVATARS_FILE` |

## ログアウト

```bash
npx -y booth-library-mcp logout
```

`session.json` とログイン用ブラウザプロファイルを削除します（BOOTH には通信しません）。キャッシュと avatars.json は残るので、不要なら保存先のフォルダごと削除してください。

## エラーコード

| コード | 意味 |
| --- | --- |
| `AUTH_REQUIRED` | ログインが必要（`booth_login` / `login`） |
| `NOT_FOUND` | 商品・注文が見つからない（削除・非公開を含む） |
| `BOOTH_CHANGED` | BOOTH のページ構造・データ形式を認識できない |
| `RATE_LIMITED` | BOOTH にリクエストを制限された |
| `NETWORK_ERROR` | 通信エラー |
| `INVALID_INPUT` | 入力が不正（ダウンロードでは保存先の外の指定、同名ファイルの存在、上限サイズ超過、無効な設定も含む） |

## 開発

```bash
bun install
bun run lint && bun run typecheck && bun run test && bun run build
```

`bun run test:live` は実際の BOOTH アカウントに通信するため、明示的に必要なときだけ手動で実行してください。
