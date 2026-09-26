# Mindrails Supervisor

A local MCP completion gate for AI agents, with optional Jev judgments and deterministic policies.

An independent open-source project by [Mindrails](https://mindrails.de).

**New: route before execution.** The separate local `jev` command asks Jev to choose between the available GPT-6 Astra, Sol and Luna models, then starts Codex with the highest-probability model. Run `npm run build`, `npm link`, then `jev --workspace-write` in your project. Each input is routed before execution; subsequent inputs include visible conversation history. New: `jev-panel` serves a small side panel (open it in Codex's in-app browser) that routes and continues a chosen conversation, with long-history selection, visible probabilities and approvals. This does **not** intercept the Codex desktop chat composer, and it cannot write to a conversation while the Codex app has it open. See [setup, failure behavior and limitations](docs/model-routing.md). This preflight argmax policy is separate from the plugin's advisory uncertainty policy below.

Check explicit requirements before an agent stops, and flag repeated steps. The host remains responsible for verification, permissions and execution.

**Jev recovery advice:** the optional Codex review now asks three additional focused questions in the same request: is the current work advancing, what is the dominant unresolved obstacle, and what next step fits? When the answers agree with sufficient confidence and selected probability, Mindrails presents a prepared follow-up prompt: resolve a prerequisite, ask for a missing decision, change approach, verify the result, or correct a missed requirement. Productive work gets no recovery interruption. Conflicts and uncertainty produce no action prompt; an environment blocker suppresses a contradictory model-upgrade suggestion. Jev classifies; application code selects the fixed wording. Prompts are never dispatched automatically.

See [the Jev-specific product comparison and validation plan](docs/jev-product-direction.md). This is a development preview; uniqueness, productivity gains and semantic accuracy have not been established.

**Uncertainty policy:** an unclear intervention preserves the host's normal path (`CONTINUE_BASELINE` / recovery `action: none`) without confirming completion. An uncertain downgrade keeps the current model; a plausible but uncertain upgrade prefers stronger-model advice under a documented quality-first rule. Fallback advice is labeled as product policy, not a confident Jev diagnosis. Clearly identified prerequisites override model changes, and clear failures remain visible. The plugin does not automatically interrupt, restart or switch a task.

## Try the free offline demo

Requires Node.js 24 or later and npm. No account or API key is needed.

```sh
git clone https://github.com/haskallalk-eng/mindrails-supervisor.git
cd mindrails-supervisor
npm ci --ignore-scripts
npm run build
npm run demo
```

Actual synthetic demo output:

```text
SYNTHETIC MOCK DEMO — no API call, no semantic evaluation
3/5 markers → CONTINUE license, security
5/5 markers → FINISH
3 repeated steps → REVIEW
changed result → CONTINUE
```

Mock mode uses explicit `[done:id]` markers and supplied fixture evidence. It demonstrates policy mechanics, not model accuracy. A Jev failure never falls back to mock.

## CLI and host loop

```sh
node examples/agent-loop.mjs
npm run e2e
npm run evidence
```

For a direct check, select the provider explicitly. Unix: `MINDRAILS_PROVIDER=mock node dist/cli.js check examples/check.json`. PowerShell: `$env:MINDRAILS_PROVIDER='mock'; node dist/cli.js check examples/check.json`. Trace triage is available as `MINDRAILS_PROVIDER=mock node dist/cli.js triage examples/trace.json`. The `stuck` command is deterministic and needs no provider.

`check <file.json>` returns an advisory decision. `stuck <file.json>` accepts `{ "steps": [{ "action": "search", "input": "q", "result": "same", "progress": false }] }`. Exit status 0 means the evaluation was returned successfully, including `continue` or `review`; the host must inspect `decision`. Invalid input/startup uses exit status 1.

## MCP tools

| Tool | Input | Result |
| --- | --- | --- |
| `check_completion` | task, currentResult, 1–20 unique requirements; optional evidence, evidenceMode and trustedChecks | finish / continue / review, reason codes, missing requirement IDs, raw model signals and provenance |
| `detect_stuck` | Up to 50 caller-supplied action/input/result/progress steps; optional `allowedExtraRepetitions` from 0–2 | At least three trailing repetitions of a one-to-three-step cycle, with zero-based matched indices |
| `triage_agent_run` | task, instructions, up to 120 transcript turns, up to 50 tool calls, final message, optional feedback/action claims and current model plus Codex usage telemetry | CONTINUE_BASELINE / AUTO_CLOSE / HUMAN_REVIEW / PRIORITY_REVIEW / FILE_ISSUE / ROUTE_PAGE_ON_CALL, reason codes, labels, provider usage, and (when current model is known) a confidence-rated keep/upgrade/faster/uncertain model-fit direction |

Trace triage asks Jev three fixed-choice questions: whether the task appears complete, whether the user explicitly accepts or rejects the result, and whether the run is healthy, misses expectations, overtly fails, or claims success without support. A deterministic policy maps those labels to a recommendation. Low confidence or uncertainty preserve the baseline without certifying success; clear dissatisfaction or an expectation gap warrant review; a silent failure is prioritized; a clear failure is recommended for issue filing. Caller-reported unpermitted actions bypass Jev and are recommended for on-call review. These labels are initial heuristics, not validated production thresholds. Recommendations are advisory and never run tools, close work, create issues, page anyone, or authorize actions.

The trace, transcript, tool arguments and results are caller supplied and treated as untrusted data. Permission claims are not independently verified. Mock mode uses explicit `[mock:...]` markers only and is synthetic; it does not assess real traces.

Completion requires every requirement and task signal to reach 0.85, and contradiction signal at most 0.1. By default `evidenceMode` is `artifact`: Jev judges whether the requested content appears in the supplied result and does not demand external proof just to confirm the artifact's contents. Set `evidenceMode` to `fact-check` when the task requires sources or verification; then global evidence or evidence on every requirement is mandatory, and Jev's evidence score must also reach 0.85. This score is not source authentication. Any declared `trustedChecks` entry with `fail` or `unknown` blocks completion. **Evidence mode and trusted-check statuses are caller-supplied, unauthenticated claims.** Use trusted host logic for consequential verification.

`finish` means this policy accepts the supplied information. It does not establish real-world success. Evidence is not fetched or independently verified. Thresholds are initial policy defaults, not calibrated guarantees. Changed results or reported progress interrupt repeat detection; four-step cycles, timestamp-changing errors and other semantic loops may go undetected. Repeat grace is caller supplied and cannot prove that polling is legitimate.

## MCP setup

Tested: official `@modelcontextprotocol/client` 2.0.0 over stdio. The following is a generic host configuration example; individual desktop hosts have not been tested:

```json
{
  "mcpServers": {
    "mindrails-supervisor": {
      "command": "node",
      "args": ["/absolute/path/to/mindrails-supervisor/dist/cli.js", "mcp"],
      "env": { "MINDRAILS_PROVIDER": "mock" }
    }
  }
}
```

On Windows use your absolute path with JSON-escaped backslashes. MCP results advise the host; this server cannot force it to continue, execute tools or switch its internal model.

## Automatic Jev review for Codex (local plugin preview)

The `plugins/jev-chat-review` package also monitors open Codex chats locally. Ask Jev to open the `open_codex_chats` overview for session status, elapsed time, repeated identical tool-call warnings, latest request token/context usage, and available Codex rate-limit pressure. Local monitoring stores derived signals only and makes no AI/API calls. At the end of a turn, the optional Jev review sends the bounded visible transcript, tool activity, current model, and usage evidence to Vercel AI Gateway. Jev then gives a confidence-rated model-fit direction when the current model is known: keep it, try a more capable model, try a faster model for comparable low-risk work, or uncertain. This advice does not change the selected model or claim measured cost savings. The feature requires `AI_GATEWAY_API_KEY` and may incur charges. Local defaults cap use at 20 reviews and 350,000 trace bytes per UTC day, with duplicate invocations skipped. These limits reduce usage but do not guarantee a fixed dollar maximum. A Jev request can delay the end of a turn by up to eight seconds. Results are advisory; Jev never continues or closes work, creates issues, pages anyone, or takes actions. Codex has no supported persistent plugin icon/panel for this use case, and the monitor has no timer that interrupts a still-running tool. Set `MINDRAILS_JEV_AUTO_REVIEW=0` or disable the plugin to stop reviews.

The hook reads Codex's local transcript, redacts common credential patterns, and sends the trace to Vercel AI Gateway. This is not a guarantee that every secret or personal detail is detected. Codex's transcript format is not a stable interface. Oversized traces are reported as unreviewed instead of silently truncated. This is a local integration preview, not a published one-click install. See [`plugins/jev-chat-review/README.md`](plugins/jev-chat-review/README.md) for setup, data handling, and limits.

## Optional Jev mode (BYOK)

Set `MINDRAILS_PROVIDER=jev` and supply `TYPESAFE_API_KEY` through your host's secret environment. Then use the same commands. The optional official Vercel compatibility route uses `MINDRAILS_JEV_ROUTE=vercel-ai-gateway` with `AI_GATEWAY_API_KEY`. Provider selection is mandatory for `check`, `triage` and `mcp`, preventing an accidental synthetic default or billable default. Environment files are not loaded automatically. Do not put keys in committed configuration or command history.

Jev mode sends task, result, requirements and supplied evidence to the selected fixed HTTPS endpoint. Inference may incur charges under the selected account. The Apache license covers this software, not either service. See [TypeSafe's API](https://docs.typesafe.ai/api), [account terms](https://typesafe.ai/legal/mca), [data policies](https://docs.typesafe.ai/legal), and [Vercel's TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). The native adapter pins `jev-1.13.0`; the gateway adapter pins Vercel's `typesafe-ai/jev` alias. Completion checks use Noul signals and trace triage uses choice signals. Both verify the returned model. A gateway result does not establish which native Jev version served the alias.

The initial twelve-case Jev run on 2026-09-23 returned `continue` for every case (7/12, same as an always-continue baseline). After separating artifact completion from optional source-backed fact-checking and lowering the initial signal threshold to 0.85, a follow-up run on the same hand-labeled cases scored 12/12 with no false finishes, false continues or provider errors. This is a tuned synthetic suite, not a production accuracy estimate; validate on held-out cases before relying on the gate. The run used 7,054 input tokens and its catalog-rate estimate was $0.00028216. See the [follow-up result](evidence/results/jev-live-vercel-2026-09-24.json), [initial result](evidence/results/jev-live-vercel-2026-09-23.json) and [method](docs/evidence.md).

A separate eight-case set was frozen before being sent to Jev and was not used for tuning: 7/8 correct, no false finishes, one false continue on a valid JSON artifact, and no provider errors. This suggests the policy errs conservatively on some structured outputs. We did not lower thresholds based on this held-out result. See the [held-out report](evidence/results/jev-heldout-vercel-2026-09-24.json).

## Limits and privacy

| Setting | Default | Scope |
| --- | --- | --- |
| MINDRAILS_MAX_CALLS | 100 | Attempts per running process, reserved before dispatch |
| MINDRAILS_MAX_INPUT_BYTES | 320000 | Cumulative serialized input bytes per process, not billed tokens |
| MINDRAILS_TIMEOUT_MS | 5000 | Total evaluation deadline including response read |
| Single input | 32000 bytes | Completion input after normalization |
| Jev request / response | 64000 bytes each | Serialized HTTP bodies |

No automatic retries. Failed attempts consume budget. Process restarts reset counters; these caps are not a durable financial spending limit. Each CLI command is a new process. The MCP server preserves counters while running. A caller with unbounded access can restart it; enforce durable quotas in your host.

No telemetry, disk trace storage, action execution, cloud service or model weights. CLI outputs include derived signals and IDs; host logs may store them. Inputs persist in memory during evaluation. TypeSafe's retention is governed separately and is not assumed to be zero. The server is advisory, not an authorization or prompt-injection security boundary.

## Development

```sh
npm run typecheck
npm test
npm pack
```

Tests cover policy vetoes, bounds, timeouts, malformed responses, budgets, loop detection, trace triage, CLI and actual MCP transport. `npm run e2e` prints eleven concrete official-client scenarios. `npm run evidence` reproduces the fixed completion comparison and deterministic-policy baselines. The datasets are synthetic; no production accuracy, cost savings or performance benchmark is claimed. See [evidence](docs/evidence.md), [architecture](docs/architecture.md), [provenance](docs/provenance.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

v0.2 intentionally excludes hosted MCP, persistent run state, dashboards, routing and automatic actions. Feedback on incorrect decisions is welcome using synthetic or redacted examples. No npm registry publication is provided; use the repository or GitHub release package.

## License

New original code: [Apache-2.0](LICENSE). Dependencies retain their own licenses; see [NOTICE](NOTICE). This project is independent of TypeSafe and is not an official Jev product.
