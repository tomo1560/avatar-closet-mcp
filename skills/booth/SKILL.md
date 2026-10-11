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
- Downloading purchased files is opt-in: `booth_download` exists only when the user enabled it (`BOOTH_MCP_ENABLE_DOWNLOAD=1` and an absolute `BOOTH_MCP_DOWNLOAD_DIR`). If it is not available, explain that instead of looking for another way to download.
- Use `booth_download` only when the user explicitly asks, one file at a time, and only for the user's own purchases. Never bulk-download a library. It saves inside the configured directory, never overwrites an existing file, and returns the saved path to report back.
- Requests are rate-limited (at most one per second). Prefer one well-targeted call over many, and do not crawl the store.
- Call `booth_logout` only when the user explicitly asks to sign out or disconnect. It deletes the saved session and the dedicated login browser profile on this computer. The profile is deleted only when this tool created it (it carries a marker file); otherwise the result carries a warning and the user must delete the profile manually.
- Preserve the redactions returned by the tools and mention material masking when it affects the answer.

## VRChat compatibility

- Results are evidence-based heuristics. Quote the returned `evidence` and its `confidence`.
- Never claim that an item supports an avatar without evidence. `unknown` means no evidence was found, not "unsupported".
- Library filters need cached item metadata. If `metadata_pending` is above zero, say that some items were not checked yet and offer `booth_sync_library_metadata` (repeat until `remaining` is 0) or the CLI command `booth-library-mcp sync` for large libraries.

## Purchase updates

- `booth_check_updates` compares the download files of every purchased item with the previous check and records the current state as the next baseline. Call it once per user request; a second call right away reports nothing new.
- On `first_run: true` nothing was compared yet: tell the user a baseline was recorded and that the next check will show changes.
- `added_files` usually means the seller uploaded a new version. Mention the new file names.
- For "updated items that support <avatar>" pass `avatar`; only supported items are returned, with `evidence`. If `metadata_pending` is above zero, some changed items were not checked yet.
- If `complete` is false the library was too large to read completely; report the warning instead of claiming there are no updates.

## Unity projects

- There is no MCP tool for scanning Unity projects. For "which of my purchases are in this Unity project?", suggest the CLI command `booth-library-mcp unity-check <projectPath>`, or combine `booth_list_library` (file names) with a Unity or file-system MCP server that can list the project's `Assets/` folders and `Packages/*.json`.

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
- Purchased items updated since the last check (optionally only those supporting an avatar): `booth_check_updates`
- Save one purchased file (opt-in; take `downloadable_id` from `booth_get_order` or `booth_list_library`): `booth_download`
