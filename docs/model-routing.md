# Jev model routing before submission

Run `jev` in your project for a local interactive conversation, or `jev "Your task"` for one task. Installed using `npm link` after `npm run build`. Node 24 and an authenticated Codex CLI are required. On Windows, `scripts/Start-Jev.ps1` refreshes the existing user-scoped gateway key and starts a conversation with workspace edits enabled. No OpenAI API key is required: execution uses the existing Codex login and its usage limits. Jev inference uses `AI_GATEWAY_API_KEY` and may incur Vercel/TypeSafe charges.

1. Read the account's current visible model catalog via the Codex app server. Candidates are available GPT-6 Astra, Sol and Luna, with catalog descriptions and their default reasoning efforts.
2. Send the upcoming task and, for a resumed conversation, visible stored history to Jev. Internal reasoning is excluded; common credentials are redacted. Repository files are not automatically loaded into the routing context.
3. Validate the full probability distribution and choose its exact maximum. Low confidence does not override the maximum. Exact ties retain the baseline if tied, otherwise prefer Astra, then Sol, then Luna.
4. Start Codex once with an explicit `--model` and a supported default reasoning effort. The original task goes over stdin, unchanged. Jev's answer is never executed as code.
5. Print the assistant's answer and keep the session ID for the next input. Each new input is independently routed using the saved visible history. `/exit` ends the local interface. `jev --resume UUID` continues a saved conversation.

The baseline is the conversation's current model (for a new conversation: the catalog default). Missing keys, timeout, HTTP error, invalid output or a request above 64 KB preserve this baseline with a visible reason and no invented probabilities. Catalog/read failures stop before dispatch. There are no automatic retries after dispatch failures. Requests to Jev time out after eight seconds; model catalog lookup after twenty seconds.

**Long conversations.** History is read page by page (`thread/turns/list`: every turn as user message + final answer, the last three turns in full). If it fits into 24 KB it is sent completely and labeled `visibleHistory: "complete"`. Otherwise Jev receives a deterministic, labeled selection (`visibleHistory: "selection"` with a disclosure sentence): the last three turns in detail (failed commands, changed files, clipped long texts), sentences from older turns that look like constraints, decisions or open problems (keyword heuristic, may miss or over-include), short digests of older turns newest first, and the first request. The panel and CLI show exactly how much was included. No model summarizes the history; nothing claims the full history was sent. Measured on the real 41-turn conversation `01a0ce29…` (4.7 MB rollout, 53 KB visible summary): 23 KB selection, about 8,000 Jev input tokens per routed message.

`jev` defaults to read-only execution. `jev --workspace-write` permits project edits. Both use Codex's sandbox and never grant additional approvals automatically; actions requiring approval fail in this noninteractive execution path. Existing user/project configuration still applies. `--ephemeral` runs an isolated one-off conversation without storing its session. Text input only; attachments and native approval dialogs are not implemented. The Stop review is disabled for these routed executions to avoid a second paid Jev review.

**This is a separate local input path. It does not intercept the native Codex desktop composer, add a chat icon, or change models in already running tasks.** The supported UserPromptSubmit hook exposes context/blocking output, but no model override. Native composer integration remains unfinished. The model probabilities are Jev's relative suitability judgments, not measured task-success rates. End-to-end execution proves dispatch works; it does not establish routing quality on real development tasks.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [model catalog and model selection at turn start](https://learn.chatgpt.com/docs/app-server).

## Side panel (`jev-panel`)

```powershell
jev-panel --thread <UUID> --cwd <project>            # continue a conversation
jev-panel --cwd <project> --workspace-write          # start new conversations with project edits
```

`scripts/Start-JevPanel.ps1 -Thread <UUID>` does the same and refreshes the user-scoped gateway key. The command prints `http://127.0.0.1:47821/?t=…`; open that address in Codex's in-app browser next to the chat (or any browser). The page is served on loopback only, needs the per-user token (stored in `%LOCALAPPDATA%\mindrails-jev\panel-token`), rejects foreign `Host` headers and cross-site form posts.

Each message: take a cross-process panel lock → start a short-lived `codex app-server` → `thread/resume` (this acquires Codex's own single-writer lock) → read history and build the context → ask Jev → `turn/start` on the same conversation with an explicit `model` and `effort` → stream the answer, commands, file changes and approval requests into the panel → close the app-server so the writer is released. Resumed conversations keep their own sandbox and approval settings; `--workspace-write` only applies to conversations the panel creates. Approval requests appear as buttons; nothing is approved automatically, and unanswered requests are declined after ten minutes. A second message while one runs is rejected (button disabled, HTTP 409, message-ID de-duplication, lock file). Note that Codex treats the `model` of a turn as the conversation's model for following turns, including ones typed later in the Codex app.

### Verified limits (Codex 0.155, desktop 26.917)

- **Conversations open in the Codex app cannot be written by any other process.** Codex enforces one writer per conversation (`thread … already has an active writer`); the desktop app holds it for loaded chats, even when a separate app-server reports `notLoaded`. The panel then refuses to send, keeps your text, and offers an explicit *Abzweig* (`thread/fork`: new conversation with a copy of the history; the original is not changed). The desktop's own app-server is not reachable from outside (no daemon socket), and its internal app-tools pipe is reserved for the app's own approved tool calls, so the panel does not use it.
- The native composer cannot be intercepted: hook output supports context/blocking (`additionalContext`, `decision`, `systemMessage`), no model override.
- The panel is not embedded in the Codex window automatically; you open its address in the in-app browser. Whether the Codex app live-refreshes a conversation that the panel wrote while the app had it unloaded was not verified (no screen access was granted); reopening the conversation shows the turns stored in its history.
- Text input only; no attachments, images, skills or mentions.

### Asking Jev about a chat (tab *Fragen*)

Pick a Claude Code session (read from `~/.claude/projects/*/<id>.jsonl`) or a Codex conversation, optionally type a yes/no question, and press *Jev fragen*. The chat is converted to visible turns (no thinking blocks, side chains or meta messages; common secrets redacted), reduced with the same labeled selection as routing, and sent to Jev in one request. Jev's API answers structured questions only, so the panel shows: progress (advancing / stalled / complete / uncertain), dominant obstacle, suggested next step, each with its top probabilities, and for your question the probability of "yes". Jev does not write prose answers, cannot browse, and nothing is executed. Errors are shown with their reason; no values are invented and nothing is retried. Live check on this Claude session: "Kann Codex im Moment Aufgaben ausführen?" → 13 % yes; obstacle "environment/access" 93 % (the Codex usage limit), about 5,200 input tokens.
