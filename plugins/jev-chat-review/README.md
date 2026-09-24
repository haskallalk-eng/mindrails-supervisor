# Jev Chat Review for Codex

This Codex plugin automatically reviews each completed agent run with Jev. A local Stop hook reads the Codex transcript and recorded tool calls, then sends a bounded trace to the configured Vercel AI Gateway Jev route. The user does not need to ask for a review, copy a transcript, or change their normal workflow.

**Data and cost:** After every completed run, user and assistant messages and recorded tool calls/results are sent to the configured provider for evaluation. This may incur charges. The hook redacts common credential patterns locally, but redaction cannot identify every secret or personal detail. Do not use this preview for sensitive conversations. Jev's result is advisory and cannot resume or close the run, open issues, page anyone, or perform other actions. Set `MINDRAILS_JEV_AUTO_REVIEW=0` in the Codex process environment, or disable/uninstall the plugin, to stop automatic reviews.

## Local development prerequisites

- Node.js 24 or later
- `npm ci` and `npm run build` from the repository root (builds the bundled MCP server in this plugin folder)
- `AI_GATEWAY_API_KEY` available to the Codex desktop process; the plugin sends it only to Vercel AI Gateway over HTTPS
- A Codex installation that supports local plugins and the Vercel AI Gateway TypeSafe-compatible route

The plugin manifest is in `.codex-plugin/plugin.json`; `hooks/hooks.json` registers the automatic Stop hook. `.mcp.json` starts the bundled local MCP server. No key is stored in plugin files. Codex asks the user to review and trust the bundled hook definition once; after that, reviews run automatically. Restart Codex after installation and make the API key available to the Codex desktop process before launching it.

## Limits

The hook reads Codex's local JSONL transcript. Codex documents that this transcript format is not a stable interface, so parsing may need updates as Codex changes. It includes only visible user/assistant messages and recorded tool calls/results; hidden reasoning and system/developer messages are excluded. Files over 10 MiB, traces over 120 messages/50 tool calls, or traces over 48 KB are rejected and reported as unreviewed; they are never silently truncated. The hook runs after a completed turn, has a 20-second host timeout and does not block the run. No transcript is stored by Mindrails. Provider handling is governed by Vercel and TypeSafe policies.

The current model alias is `typesafe-ai/jev`; it does not identify the native Jev model version. The evaluation suites are small, hand-authored checks and do not establish production accuracy.
