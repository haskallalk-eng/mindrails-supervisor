# Jev Chat Review for Codex

This Codex plugin has two separate features. The local monitor tracks open Codex chats across sessions and exposes an `open_codex_chats` overview in the Jev tools. It flags long turns and repeated identical tool calls, then gives cautious, heuristic model-fit suggestions. Monitoring stores no prompts, tool inputs or outputs, and makes no AI/API calls. Separately, the optional automatic Jev review reads the completed chat transcript and sends a bounded trace to the configured Vercel AI Gateway Jev route.

**Data and cost:** Local monitoring records a hashed session ID, project folder name, selected model, timestamps, counters and hashes of recent tool actions in the plugin data folder. It does not retain prompt text, tool inputs/results or transcript contents. It makes no inference requests. The separate optional review sends visible user/assistant text and recorded tool calls/results at each completed agent turn. Earlier turns are included again when the same Codex chat continues, so longer conversations use more tokens. The default local limit is 20 reviews and 350,000 trace bytes per UTC day. Duplicate invocations for the exact same transcript are skipped. The review feature stores only transcript/session hashes and daily counters, never chat text. Limits can be changed with `MINDRAILS_JEV_DAILY_REVIEW_LIMIT` (1–500) and `MINDRAILS_JEV_DAILY_INPUT_BYTES` (1–10,000,000); set `MINDRAILS_JEV_AUTO_REVIEW=0` or disable/uninstall the plugin to stop reviews. Byte/call limits reduce usage but are not a dollar-denominated guarantee; pricing depends on current model rates. The user's configured Vercel account pays for requests. The hook redacts common credential patterns locally, but redaction cannot identify every secret or personal detail. Do not use automatic review for sensitive conversations.

At the end of a Codex turn, the local Stop hook surfaces relevant warnings and model-fit suggestions. The open-chat overview is also available as an on-demand MCP tool rather than a persistent icon or always-visible panel. Ask Jev to “show open chats” to see current sessions and their suggestions while they run. The overview is advisory: model recommendations are simple local heuristics and never switch a model automatically. A “stronger model” hint indicates repeated identical tool calls, not a measured comparison of model quality. Duration warnings can only be surfaced when a hook event runs or when the overview is requested; the plugin does not run a separate background timer to interrupt a still-running tool.

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
