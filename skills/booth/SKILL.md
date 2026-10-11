---
name: booth
description: Use for requests about the user's own BOOTH account as a buyer, such as signing in to BOOTH, checking whether BOOTH is connected, or signing out. Automatically use the bundled read-only BOOTH MCP tools without asking which MCP server is installed. Unofficial tool, not affiliated with pixiv or BOOTH. Do not use for BOOTH seller shop management, fees, policies, or other public information unrelated to the user's account.
---

# BOOTH library (buyer)

Unofficial tool, not affiliated with pixiv or BOOTH. Use the bundled `booth_*` tools for the user's own BOOTH buyer account.

## Workflow

- Call the task-specific tool directly. Do not check authentication before every request.
- If BOOTH tools are not visible, search the available tools for `booth` or `booth_*`, then continue without asking the user which MCP servers are installed.
- If a tool returns `AUTH_REQUIRED`, explain that a browser window will open for a manual pixiv sign-in, call `booth_login`, and retry the original request.
- Never ask for, type, or store the user's pixiv or BOOTH password. Sign-in always happens by the user in the browser window.
- Do not use web search for private purchase data.
- Treat BOOTH as read-only. Do not claim to buy items, change carts or wish lists, or modify BOOTH data.
- Call `booth_logout` only when the user explicitly asks to sign out or disconnect. It deletes the saved session and the dedicated login browser profile on this computer.
- Preserve the redactions returned by the tools and mention material masking when it affects the answer.

## Tool routing

- Connect or sign in to BOOTH: `booth_login`
- Connection status or signed-in account name: `booth_auth_status`
- Sign out, disconnect, or remove saved BOOTH credentials: `booth_logout`

When additional `booth_*` buyer tools are listed (library, gifts, orders, item details, search), prefer them over web search for questions about the user's purchases.
