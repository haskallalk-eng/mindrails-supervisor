# Jev Chat Review for Codex

This Codex plugin automatically reviews each completed Codex agent turn with Jev. A local Stop hook reads the transcript and recorded tool calls, then sends a bounded trace to the configured Vercel AI Gateway Jev route. It shows a short German explanation of Jev's assessment, the next useful check, and token usage. The user does not need to ask for a review, copy a transcript, or change their normal workflow.

**Data and cost:** At each completed agent turn, visible user and assistant messages and recorded tool calls/results are sent to the configured provider for evaluation. Earlier turns are included again when the same Codex chat continues, so longer conversations use more tokens. The default local limit is 20 reviews and 350,000 trace bytes per UTC day. Duplicate invocations for the exact same transcript are skipped. The plugin stores only transcript/session hashes and daily counters in Codex's plugin data folder, never the chat text. Limits can be changed with `MINDRAILS_JEV_DAILY_REVIEW_LIMIT` (1–500) and `MINDRAILS_JEV_DAILY_INPUT_BYTES` (1–10,000,000); set `MINDRAILS_JEV_AUTO_REVIEW=0` or disable/uninstall the plugin to stop reviews. Byte/call limits reduce usage but are not a dollar-denominated guarantee; pricing depends on current model rates. The user's configured Vercel account pays for requests. The hook redacts common credential patterns locally, but redaction cannot identify every secret or personal detail. Do not use this preview for sensitive conversations. Jev's result is advisory and cannot resume or close the run, open issues, page anyone, or perform other actions.

## Local development prerequisites

- Node.js 24 or later
- `npm ci` and `npm run build` from the repository root (builds the bundled MCP server in this plugin folder)
- `AI_GATEWAY_API_KEY` available to the Codex desktop process; the plugin sends it only to Vercel AI Gateway over HTTPS
- A Codex installation that supports local plugins and the Vercel AI Gateway TypeSafe-compatible route

The plugin manifest is in `.codex-plugin/plugin.json`; `hooks/hooks.json` registers the automatic Stop hook. `.mcp.json` starts the bundled local MCP server. No key is stored in plugin files. Codex asks the user to review and trust the bundled hook definition once; after that, reviews run automatically. Restart Codex after installation and make the API key available to the Codex desktop process before launching it.

## Limits

The hook reads Codex's local JSONL transcript. Codex documents that this transcript format is not a stable interface, so parsing may need updates as Codex changes. It includes only visible user/assistant messages and recorded tool calls/results; hidden reasoning and system/developer messages are excluded. Files over 10 MiB, traces over 120 messages/50 tool calls, or traces over 48 KB are rejected and reported as unreviewed; they are never silently truncated. Jev's provider call has an eight-second deadline; because the hook runs at the end of a turn, it can delay the visible completion while it waits. It never asks Codex to continue work or block on Jev's recommendation. No transcript is stored by Mindrails. Provider handling is governed by Vercel and TypeSafe policies.

This is a BYOK development preview, not a Mindrails-hosted inference service. A managed Mindrails key would require a hosted billing proxy with user authentication, quotas, abuse controls, and a funded usage allowance; this repository does not provide that backend.

The current model alias is `typesafe-ai/jev`; it does not identify the native Jev model version. The evaluation suites are small, hand-authored checks and do not establish production accuracy.
