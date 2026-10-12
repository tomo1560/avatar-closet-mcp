# Repository Guidelines

## Development

- Use npm for dependency management and project commands.
- Run `npm ci` to install dependencies. Use `npm install` only when changing dependencies, and commit the updated `package-lock.json`.
- After meaningful changes, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` as applicable.
- Run `npm run test:live` only when explicitly requested because it uses a real BOOTH account.

## Design Constraints

- Keep the MCP runtime read-only. BOOTH data requests must use HTTP `GET` only.
- Use Chrome or Edge only for interactive login; normal MCP queries must not launch a browser.
- Keep `playwright-core` external to the bundled `dist/cli.js` output.
- Never commit real sessions, orders, conversations, or other account data. Test fixtures must contain fictional data only.
- Preserve masking of personal contact, address, and message data.

## Release

- `package.json` is the only version source. Do not edit `.codex-plugin/plugin.json` or the pinned version in `.mcp.json` directly.
- The npm `version` lifecycle synchronizes generated version metadata. Run `npm run check:distribution` before release work and do not bypass a drift failure.
- For a patch release, run `npm version patch`, then `git push origin main --follow-tags`.
- Use `npm version minor` for backward-compatible features and `npm version major` for breaking changes.
- Pushing the version tag triggers the npm release workflow. Do not run `npm publish` manually.
