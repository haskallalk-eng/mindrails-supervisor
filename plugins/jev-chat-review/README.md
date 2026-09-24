# Jev Chat Review for Codex

This local plugin adds a `review-current-chat` skill and the Mindrails Supervisor MCP server. After installation, the user can ask Codex to review the current run; the agent builds a concise summary from its visible context and calls `triage_agent_run`. The user does not copy or upload a transcript.

The skill runs only when the user explicitly asks for a review. It tells the user that the summary will be sent to the configured Jev provider and may incur charges. It instructs Codex to omit secrets and unrelated personal details, but this is not a deterministic redaction guarantee. The result is advisory; it cannot resume or close the chat, open issues, page anyone, or perform other actions.

## Local development prerequisites

- Node.js 24 or later
- `npm ci` and `npm run build` from the repository root (builds the bundled MCP server in this plugin folder)
- `AI_GATEWAY_API_KEY` available to the Codex desktop process
- A Codex installation that supports local plugins and the Vercel AI Gateway TypeSafe-compatible route

The plugin manifest is in `.codex-plugin/plugin.json`. `.mcp.json` starts the bundled server with Jev selected and passes the API key through the host environment; no key is stored in this plugin. Restart Codex after installing or changing plugin files, then start a new chat so the server and skill are reloaded.

## Limits

The skill uses the current conversation context available to Codex, not a private transcript-reading API. It includes relevant turns and tool outcomes and instructs the model to omit unrelated or sensitive details. No full transcript is stored by Mindrails. Provider handling is governed by Vercel and TypeSafe policies.

The current model alias is `typesafe-ai/jev`; it does not identify the native Jev model version. The evaluation suites are small, hand-authored checks and do not establish production accuracy.
