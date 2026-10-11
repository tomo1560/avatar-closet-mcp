---
name: booth
description: Use for requests about the user's own BOOTH account as a buyer (purchased library items, gifts, orders, signing in or out) and for BOOTH item lookups, searches, and VRChat avatar compatibility checks (for example "which of my outfits support Shinano?" or "does this item support Kikyo?"). Automatically use the bundled read-only BOOTH MCP tools without asking which MCP server is installed. Unofficial tool, not affiliated with pixiv or BOOTH. Do not use for BOOTH seller shop management, fees, or policies.
---

# BOOTH library (buyer)

Unofficial tool, not affiliated with pixiv or BOOTH. Use the bundled `booth_*` tools for the user's own BOOTH buyer account and for public BOOTH item data.

## Workflow

- Call the task-specific tool directly. Do not check authentication before every request.
- If BOOTH tools are not visible, search the available tools for `booth` or `booth_*`, then continue without asking the user which MCP servers are installed.
- If a tool returns `AUTH_REQUIRED`, explain that a browser window will open for a manual pixiv sign-in, call `booth_login`, and retry the original request.
- Never ask for, type, or store the user's pixiv or BOOTH password. Sign-in always happens by the user in the browser window.
- Do not use web search for private purchase data.
- Treat BOOTH as read-only. Do not claim to buy items, change carts or wish lists, or modify BOOTH data.
- Requests are rate-limited (at most one per second). Prefer one well-targeted call over many, and do not crawl the store.
- Call `booth_logout` only when the user explicitly asks to sign out or disconnect. It deletes the saved session and the dedicated login browser profile on this computer.
- Preserve the redactions returned by the tools and mention material masking when it affects the answer.

## VRChat compatibility

- Results are evidence-based heuristics. Quote the returned `evidence` and its `confidence`.
- Never claim that an item supports an avatar without evidence. `unknown` means no evidence was found, not "unsupported".
- Library filters need cached item metadata. If `metadata_pending` is above zero, say that some items were not checked yet and offer `booth_sync_library_metadata` (repeat until `remaining` is 0) or the CLI command `booth-library-mcp sync` for large libraries.

## Tool routing

- Connect or sign in to BOOTH: `booth_login`
- Connection status or signed-in account name: `booth_auth_status`
- Sign out, disconnect, or remove saved BOOTH credentials: `booth_logout`
- Purchased items, optionally filtered by name, avatar, kind, or dependency: `booth_list_library` (use `all: true` for questions about the whole library)
- Received gifts: `booth_list_gifts`
- Order history: `booth_list_orders`; one order: `booth_get_order`
- Item details from an item id or URL: `booth_get_item` (set `include_vrchat` for avatar, dependency, and Quest information)
- Does an item support an avatar: `booth_check_compatibility`
- Search BOOTH: `booth_search_items`; tag names: `booth_suggest_tags`
- Find items for a specific avatar: `booth_search_for_avatar`
- Avatars the user owns and the avatar dictionary: `booth_list_my_avatars`
- Pre-fetch item metadata for the whole library: `booth_sync_library_metadata`
