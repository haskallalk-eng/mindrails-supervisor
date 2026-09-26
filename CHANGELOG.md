# Changelog

## Unreleased — local Jev calibration update

- Jev 0.7.0: graded, visible result per new task (user rule). Setting fits: a check mark. One step off (effort level or capability tier): a card in the chat ("⚙ JEV · EFFORT ÄNDERN – 1 STUFE ZU HOCH", scale ◆ recommended / ● set; Codex wording "Denkaufwand" from the parallel Codex session) and the Jev figure, a small always-on-top window at the bottom right of the Claude/Codex window that never takes the focus (Windows, `#jev figur an|aus|test`). Two or more steps off: the message is held once; the next send within 15 minutes passes. Claude desktop: the live menu setting is read from the app's chat file, so a menu change counts at once. Hard tasks get one effort level above the model's sweet spot, never into the range rated too much.
- Jev 0.6.0: Jev itself decides first whether a message is a new task (yes/no question in the same Jev call, no length rule of ours); only then it shows one line on model and effort. No message is ever held: `#jev an <Text>`, `#jev aus <Text>` and `#jev <Text>` send the text (0.5.0 held `#jev an <Text>` as an analysis). The 0.5.0 model/effort skills are removed: a live test in the Claude desktop app showed that skill `model`/`effort` never reached the requests (menu setting enforced per request). Codex no longer holds messages either.
- (0.5.0, withdrawn in 0.6.0: had no effect in the Claude desktop app) Claude Code: Jev was meant to set the effort for every message itself and switch the model with one click ("Jev folgen"). This works through ten plugin skills whose `model`/`effort` frontmatter applies to the rest of the message. The next prompt checks in the transcript what really ran; `#jev status` shows it. Codex keeps the hold-and-resend flow because it has no override interface. Plugins 0.5.0.

- Weighted practitioner/user model spectrum (668 model/task and 171 effort statements; credibility × quality × recency weighting) in `src/model-spectrum.ts`, rebuilt by `npm run spectrum`: vetoes benchmark picks that credible voices rate weak for the task, decides where no benchmark exists, and sets effort per model (plugins 0.4.0).

- Jev plugins for Claude Code (`plugins/jev-claude`) and Codex (`plugins/jev-codex`), installable from this repo's marketplaces; one self-contained hook bundle, no build step.
- Benchmark-based model policy (`src/model-policy.ts`, `src/model-benchmarks.ts` with sources): Jev classifies task kind and difficulty; switches only for a 4+ point gap or a 25%+ saving at equal quality.
- Codex support: rollout reader, current model and effort from the conversation, tiers and exact effort ids from the local Codex model catalog.
- Exact effort ids and app labels (Niedrig/Mittel/Hoch/Extra hoch/Max, Codex `ultra`); no effort for Haiku 4.5.

- Add `jev-panel`: loopback side panel that routes each message with Jev and runs it in the same Codex conversation via `codex app-server` (explicit model/effort per turn, streaming, user-answered approvals, stop, explicit fork).
- Prevent double submits and parallel runs (UI, HTTP 409, message de-duplication, cross-process lock); respect Codex's single-writer lock instead of writing to conversations open in the Codex app.
- Replace the 64 KB fallback for long conversations with a paginated, labeled selection of recent turns, constraints/decisions/problems and older-turn digests; use the conversation's current model as baseline.
- Add a *Fragen* tab: Jev reads a Claude Code session or Codex conversation and returns progress, obstacle, next step and the probability for a user yes/no question.
- Auto-detect the Codex desktop's bundled CLI when `codex` is not on PATH.

- Add an automatic Codex turn review with plain-language German guidance and visible provider token usage.
- Add a persistent per-install daily call/trace-byte budget, duplicate suppression, local usage accounting, and no-transcript-storage state.
- Disclose repeat transmission of conversation history, provider charges, redaction limits, and the lack of a managed Mindrails inference service.
- Separate artifact completion from explicit source-backed `fact-check` mode; only fact-check mode hard-gates on supplied evidence.
- Adjust the initial signal threshold from 0.90 to 0.85 based on the five false continues in the first frozen Jev suite.
- Re-run the same twelve synthetic cases through Vercel Jev: 12/12 correct, no false finishes, false continues or provider errors; document that this tuned set is not held-out validation.
- Add a separate frozen eight-case held-out Jev check: 7/8 correct, zero false finishes, one false continue, zero provider errors; leave the policy unchanged after the run.
- Add a live sanitized result and update CLI, MCP examples, policy tests and documentation.

## 0.2.0 — 2026-09-23

- Detect trailing cycles of one to three steps, including A-B and A-B-C loops.
- Add a caller-declared, bounded repeat grace and report when it expires.
- Require an explicit provider for CLI and MCP operation; the demo stays explicitly synthetic.
- Correct mock evidence handling when every requirement supplies evidence.
- Surface Jev token usage separately from semantic signals.
- Add a real MCP scenario runner, fixed baseline evidence and a double-gated live Jev check.
- Add the official fixed Vercel TypeSafe-compatible Jev route with distinct model provenance.
- Document measured implementation gains and the first bounded live Jev gateway result (7/12, no false finishes or provider errors).

## 0.1.0 — 2026-09-23

- Add local completion policy and deterministic repeated-step detection.
- Provide JSON CLI and stdio MCP tools.
- Add offline synthetic demo and bounded host-loop example.
- Add optional Jev HTTP adapter with deadlines, request/response bounds and attempt/input budgets.
- Validate policy and actual MCP transport offline. Live Jev inference remains untested.
