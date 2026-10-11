# booth-library-mcp

> [!IMPORTANT]
> **非公式ツールです。pixiv / BOOTH とは一切関係ありません。**
> 自分の BOOTH アカウントの購入データ（ライブラリ・ギフト・注文履歴）を読み取り専用で扱う MCP サーバー + CLI として開発中です（計画: [PLAN.md](PLAN.md)）。
> 以下の韓国語の説明は上流（出品者向け）のもので、購入者向け機能の実装に合わせて書き換える予定です。

本プロジェクトは [cstria0106/booth-mcp](https://github.com/cstria0106/booth-mcp)（MIT License）のフォークです。原作者に感謝します。ライセンスは同じく MIT です（[LICENSE](LICENSE)）。

---

BOOTH 판매자 관리 정보를 MCP 클라이언트에서 조회하는 비공식·읽기 전용 MCP 서버입니다.

> 이 프로젝트는 pixiv 또는 BOOTH의 공식 프로젝트가 아닙니다. BOOTH의 화면 구조가 바뀌면 일부 기능이 동작하지 않을 수 있습니다.

## 기능

- 로그인 상태와 대시보드
- 상품 목록과 디지털 상품 상세
- 주문 목록과 주문 상세
- 월별·일별·상품별 매출
- 메시지 목록과 대화 내용
- 공개 샵 정보와 비금융 설정

데이터 생성·수정·삭제, 발송 처리, 메시지 전송, 파일 다운로드, CSV 발행, 지급 신청은 지원하지 않습니다.

## 요구 사항

- Node.js 20 이상
- 최초 로그인 화면을 표시할 수 있는 데스크톱 환경
- Google Chrome 또는 Microsoft Edge

## Codex 설치

```bash
# marketplace add の手順はフォーク版リポジトリの公開後に記載します
codex plugin add booth-library-mcp@booth-library-mcp
```

설치 또는 업데이트 후 새 작업을 시작하세요. 플러그인을 업데이트하려면 다음 명령을 사용합니다.

```bash
codex plugin marketplace upgrade booth-library-mcp
codex plugin add booth-library-mcp@booth-library-mcp
```

## 로그인

MCP에서 `booth_login`을 호출하거나 터미널에서 로그인할 수 있습니다.

```bash
npx -y booth-library-mcp login
```

Chrome과 Edge를 찾지 못하면 브라우저 경로를 지정하세요.

```bash
# macOS/Linux
BOOTH_MCP_BROWSER_PATH=/path/to/chrome npx -y booth-library-mcp login

# Windows PowerShell
$env:BOOTH_MCP_BROWSER_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npx -y booth-library-mcp login
```

Windows에서는 기본적으로 다음 경로에 로그인 정보가 저장됩니다.

```text
%LOCALAPPDATA%\booth-library-mcp\browser-profile
%LOCALAPPDATA%\booth-library-mcp\session.json
```

저장 위치는 `BOOTH_MCP_PROFILE_DIR`과 `BOOTH_MCP_SESSION_FILE`로 변경할 수 있습니다.

## 기타 MCP 설정

Codex에서 플러그인 없이 사용하려면 다음 설정을 추가합니다.

```toml
[mcp_servers.booth]
command = "npx"
args = ["-y", "booth-library-mcp"]
```

Claude Desktop과 Cursor에서는 MCP 설정에 다음 항목을 추가합니다.

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

## 도구 목록

| 도구 | 설명 |
| --- | --- |
| `booth_login` | BOOTH 로그인 |
| `booth_auth_status` | 로그인 상태와 샵 정보 조회 |
| `booth_get_dashboard` | 샵 상태와 최근 매출 조회 |
| `booth_list_items` | 상품 목록 조회 |
| `booth_get_item` | 상품 상세 조회 |
| `booth_list_orders` | 주문 목록 조회 |
| `booth_get_order` | 주문 상세 조회 |
| `booth_get_sales` | 매출 조회 |
| `booth_list_conversations` | 대화 목록 조회 |
| `booth_get_conversation` | 대화와 메시지 조회 |
| `booth_get_shop_settings` | 공개 샵 정보와 비금융 설정 조회 |

## 보안과 제약

- BOOTH 데이터는 조회만 하며 변경하지 않습니다.
- 주문 상세의 실명, 주소, 전화번호, 이메일은 마스킹합니다.
- 메시지 본문의 이메일, 전화번호, 우편번호는 마스킹하지만 자유 형식 개인정보를 모두 탐지하지 못할 수 있습니다.
- `session.json`에는 BOOTH 세션 쿠키가 포함되므로 공유하거나 저장소에 커밋하지 마세요.
- 정산 계좌와 법적 판매자 정보는 조회하지 않습니다.

## 오류 코드

- `AUTH_REQUIRED`: 로그인이 필요함
- `NOT_FOUND`: 요청한 상품·주문·대화를 찾을 수 없음
- `BOOTH_CHANGED`: BOOTH 화면 구조를 인식할 수 없음
- `RATE_LIMITED`: BOOTH가 요청을 제한함
- `NETWORK_ERROR`: 네트워크 또는 BOOTH 응답 오류

## 라이선스

MIT
