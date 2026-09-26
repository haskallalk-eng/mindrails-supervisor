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

### Assistant tab

The default *Assistent* tab targets the **most recently updated** Claude Code session or Codex conversation (the panel cannot see which window you are looking at; you can pick another chat). *Analysieren* returns progress, obstacle and next step in one line. Type the next task and press *Modell vorschlagen*: Jev picks among Opus 5.5 / Sonnet 5 / Haiku 4.5 for Claude chats (Fable 5.1 is not offered because its intended use is not documented here) or the Codex catalog models, using the chat as context; nothing is executed and the switch is up to you (*Aufgabe kopieren* copies the task). Optional auto mode analyzes the current chat once it has been unchanged for 20 s after an update, at most every two minutes; each run is a paid Jev call. Keep one panel tab open: every tab holds a live connection and browsers allow only six per address.

### Knowing which chat you are in: prompt hooks and `#jev`

The panel cannot see which window is focused. Instead, prompt hooks record the chat you last typed in (`%LOCALAPPDATA%\mindrails-jev\focus.json`: kind, id, time, cwd — no prompt text), and the *Assistent* tab uses it (“hier hast du zuletzt geschrieben”), falling back to the most recently updated chat.

- Claude Code: `~/.claude/settings.json` → `hooks.UserPromptSubmit` runs `node <repo>/dist/jev-hook.js` (exec form, 30 s timeout). Normal prompts pass unchanged (~0.25 s). `#jev` analyzes the current chat, `#jev <task>` also recommends Opus/Sonnet/Haiku for that task, `#jev? <question>` answers a yes/no question. These commands are blocked before reaching Claude (no Claude tokens) and Jev's answer is shown as the block reason. Each is one paid Jev call.
- Codex: the `jev-chat-review` plugin adds `hooks/jev-focus.mjs` to `UserPromptSubmit` (async, id only). The installed plugin copy under `~/.codex/plugins/cache/local-jev-dev/…` must contain it; Codex loads hooks at start.

Computer use is not used for this: it would need screen access every time, is slow, and the panel cannot invoke Claude anyway.

### Guard mode and effort (Claude Code)

`#jev an` turns on the guard: every new prompt (not slash commands, not replies under 20 characters) is first sent to Jev, which recommends one of Fable 5.1 / Opus 5.5 / Sonnet 5 / Haiku 4.5 (list prices included in the criteria) and an effort level (low … max), and shows the current model from the transcript. The prompt is held; sending the identical text again within 15 minutes lets it through, so switching model/effort in the model menu first is optional. If Jev fails, the prompt is sent normally with a notice. `#jev aus` turns the guard off; `#jev hilfe` lists the commands.

The hook cannot switch the model: Claude Code hooks can block or add context, not change the model, and a Claude session may not re-price itself. Only another Claude session can switch a chat's model/effort through the desktop app's session tools, and the app then asks the user to confirm.
