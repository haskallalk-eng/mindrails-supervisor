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

### Guard mode: model and effort per message (Claude Code)

`#jev an` turns Jev on **for that chat only** (stored per session id, stays on until `#jev aus`). For every new prompt except slash commands, the hook decides what the message should run on. It then makes Claude switch before any work starts.

- **Mechanism, verified in the Claude Code 2.1.281 source.** UserPromptSubmit hook output has no model or effort field (`additionalContext`, `sessionTitle`, `suppressOriginalPrompt`). The desktop app's session tools refuse to re-price the calling session. Skills can do it: when the Skill tool runs, frontmatter `model` and `effort` become context layers that apply to every later API request of the same message. They are cleared when the user sends the next message.
- **No permission prompt.** A skill whose frontmatter only uses safe fields (`name`, `description`, `model`, `effort`, `user-invocable`) runs without a prompt in every permission mode.
- **What the plugin ships.** Ten such skills, `jev:model-fable-5-1|opus-5-5|opus-5|sonnet-5|haiku-4-5` and `jev:effort-low|medium|high|xhigh|max`, generated by `scripts/build-jev-skills.mjs`. The hook adds `additionalContext` telling Claude to invoke the ones it needs first.
- **Effort.** Set automatically whenever Jev's effort for the running model differs from the menu. The menu itself is not changed.
- **Model.** A switch is proposed when the policy recommends a different model: a gap of at least 4 benchmark points, a saving of at least 25 % at equal quality, or the current model is vetoed. Claude first asks one AskUserQuestion: "Jev folgen" or "<model> behalten".
  - "Jev folgen" invokes the model skill, plus the effort skill if needed.
  - Jev then applies that model on every message until it recommends something else or the user picks the model in the menu.
  - A declined model is not offered again until Jev once says the current model fits.
- **Short follow-ups and outages.** Follow-ups under 20 characters skip the Jev call and keep the last model and effort. If Jev fails, the chat keeps the last setting and says so.
- **Verification.** For every reply, the transcript records `message.model` and the effort actually sent: `effort` is the request's `output_config.effort`, and `perTurnEffort` is the per-turn effort in effect.
  - The first reply of a message shows the menu setting; the last reply shows what the work ran on.
  - At the next prompt the hook compares this with what it set. It logs the result to `guard-log.jsonl` (`applied`, `accepted`, `declined`, `not-asked`, `not-applied`; no prompt text), warns in the chat if the two differ, and `#jev status` shows it.
- **Limits.**
  - The first reply of each message still runs on the menu model and effort, because it only invokes the skill. In a long chat this adds one extra, mostly cached, pass over the context.
  - Switching model mid-message starts with that model's prompt cache cold.
  - The switch depends on Claude following the instruction. The check above reports when it did not.
  - In auto mode, Claude Code keeps the session model when a skill names a model that auto mode does not support. For first-party accounts that is only Opus 4.6; on other providers it also covers Sonnet 4.6 and Haiku.

Codex hooks and skills have no model or effort override, so Codex keeps the older flow. Short replies pass. When the current model fits, the prompt passes with an effort tip. Otherwise it is held once, and sending the identical text again within 15 minutes lets it through. `#jev hilfe` lists the commands.

### Tiers, threshold and evidence

Jev chooses a capability tier, not a version: Spitze (Fable 5.1/5), Stark (Opus 5.5/5/4.8/4.7/4.6), Alltag (Sonnet 5/4.6), Schnell (Haiku 4.5). Any model id is mapped by family, including settings aliases such as `fable[1m]`; if the transcript has no assistant message yet, the model from `~/.claude/settings.json` is used. The guard never interrupts within a tier, never when the current model is unknown, and between tiers only when Jev's top tier has at least 50 % and leads the current tier by at least 25 points (`GUARD_MIN_TOP`, `GUARD_MIN_MARGIN` in `src/chat-inspect.ts`).

Tier and effort criteria quote Anthropic's published measurements from the Claude API cost-optimization guidance (e.g. Opus 5 matched Fable 5 on a coding subset, 91.7 % vs 91.3 %, at about 60 % of the cost; Haiku 4.5 63 % vs Opus 5 92 % on knowledge questions at about a tenth of the cost; effort curves for research vs long-horizon coding). They were measured by Anthropic on Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5, not independently and not on Fable 5.1 / Opus 5.5; no independent per-model benchmark numbers are embedded. The cost line is exact arithmetic on list prices per token; cost per task can differ. Jev's probabilities remain relative judgments, not calibrated success rates.

Every guard decision is appended to `%LOCALAPPDATA%\mindrails-jev\guard-log.jsonl` (time, session id, current model, recommended tier, probabilities, whether the user followed — never prompt text), so recommendations can later be checked against real outcomes.

### Benchmark policy (replaces the tier threshold where data exists)

Jev classifies each task into a kind (`coding`, `agentic`, `reasoning`, `research`, `simple`) and a difficulty (`easy`, `normal`, `hard`). `src/model-policy.ts` then decides deterministically from `src/model-benchmarks.ts` (FrontierCode v1.1 Main for coding, Terminal-Bench 4.0 for agentic work, the Artificial Analysis Intelligence Index for reasoning/research; each score with source URL, vendor/independent, as of 2026-09-26):

- Candidates within a tolerance of the best score count as equally good (easy 10, normal 5, hard 2 points); the cheapest of them is recommended (Claude: list price per output token; Codex: measured cost per task).
- The user is interrupted only for a quality gap of at least 4 points (user-set; published scores carry roughly ±2–5 points of noise and vendor-harness differences) or a saving of at least 25 % while the current model is not better beyond tolerance. Simple tasks use the cheapest model if that saves at least 25 %.
- Where no comparable published score exists (Sonnet 5, Haiku 4.5, Opus 4.x on these benchmarks), the previous tier judgment by Jev is used and this is stated in the output.
- Effort is Jev's choice clamped to the levels the recommended model offers in that app: Claude `low/medium/high/xhigh/max` (shown as Niedrig/Mittel/Hoch/Extra hoch/Max; none for Haiku 4.5), Codex per model from `~/.codex/models_cache.json` (e.g. `ultra` only for some GPT-6 models). In Codex the current effort is read from the conversation and shown next to the recommendation.

### Packaging

`plugins/jev-claude` (Claude Code plugin, marketplace `.claude-plugin/marketplace.json`) and `plugins/jev-codex` (Codex plugin, marketplace `.agents/plugins/marketplace.json`) contain the same self-contained hook bundle (`hooks/jev-guard.mjs`, built by `npm run build:jev-plugins`), so installing from GitHub needs no build step. The Claude plugin also ships the ten model/effort skills described above. Neither is an MCP server: MCP servers offer tools the model may call, whereas Jev must run before the model sees the prompt, which only a prompt hook can do.

### Weighted practitioner/user spectrum (`src/model-spectrum.ts`)

Benchmarks cover only some models and task types. A second evidence source is a weighted spectrum built from 668 collected statements ("model X is good/bad at task Y") and 171 effort statements from Hacker News, Reddit, X/YouTube, GitHub, developer blogs, tool vendors and non-English communities (`data/spectrum-claims/`, rebuilt with `npm run spectrum`; overview in [model-spectrum.md](model-spectrum.md)). Each statement is weighted by

- credibility of the author (researcher/benchmark org 1.3, practitioner with structured tests or usage data 1.2, individual user 0.8, model vendor 0.8, press 0.6),
- platform (paper/benchmark 1.2, GitHub 1.1, Hacker News and blogs 1.0, Reddit/X/forums 0.85, YouTube/news 0.8),
- quality of the statement (measured/tested ×2, clear experience ×1, passing remark ×0.4),
- recency (September 1.0 … June 0.7) and vendor self-interest (vendor praising its own model ×0.6, about competitors ×0.5).

Repeats of the same point from the same thread/article count 30 % beyond the first; statements dated before a model's release are dropped (month-only dates count as the end of the month). Per model and task the score is 100·(positive − negative)/(total + 2), so thin evidence stays near 0; evidence is *strong* (weight ≥ 8 from ≥ 5 sources), *medium* (≥ 3 from ≥ 2) or *weak*. Effort verdicts (best / enough / too little / too much / worse than lower) vote for the level to use per model; task-specific effort votes count half toward the model's general level. Mislabelled effort verdicts found in a manual review are corrected and listed in `data/spectrum-claims/CORRECTIONS.md`.

How the policy uses it:

- **Veto**: a benchmark candidate rated clearly weak for the task (score ≤ −25 with strong or ≤ −40 with medium evidence) is not recommended; if the *current* model is vetoed, Jev recommends switching (`current-vetoed`).
- **Fallback** where no comparable benchmark exists (e.g. Sonnet 5, Haiku 4.5): the best-rated model with at least medium evidence is recommended only if it leads the current model by ≥ 30 spectrum points.
- **Effort per model**: the level the weighted verdicts point to for that model (task-specific only with strong evidence, else the model's general level with at least medium evidence), shown with "nicht … oder höher" when higher levels were reported as wasteful or worse; otherwise Jev's pick, always clamped to levels the app offers for that model. Effort is not assumed comparable across models or vendors.
