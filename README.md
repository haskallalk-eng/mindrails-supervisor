# Mindrails Supervisor

A local MCP completion gate for AI agents, with optional Jev judgments and deterministic policies.

An independent open-source project by [Mindrails](https://mindrails.de).

Check explicit requirements before an agent stops, and flag repeated steps. The host remains responsible for verification, permissions and execution.

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
| `triage_agent_run` | task, instructions, up to 30 transcript turns, up to 20 tool calls, final message, optional user feedback and action permission claims | AUTO_CLOSE / HUMAN_REVIEW / PRIORITY_REVIEW / FILE_ISSUE / ROUTE_PAGE_ON_CALL, reason codes, Jev labels, provider and confidence |

Trace triage asks Jev three fixed-choice questions: whether the task appears complete, whether the user explicitly accepts or rejects the result, and whether the run is healthy, misses expectations, overtly fails, or claims success without support. A deterministic policy maps those labels to a recommendation. Low confidence, uncertainty, incomplete work, dissatisfaction, or an expectation gap go to human review; a silent failure is prioritized; a clear failure is recommended for issue filing. Caller-reported unpermitted actions bypass Jev and are recommended for on-call review. These labels are initial heuristics, not validated production thresholds. Recommendations are advisory and never run tools, close work, create issues, page anyone, or authorize actions.

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

The `plugins/jev-chat-review` package also monitors open Codex chats locally. Ask Jev to open the `open_codex_chats` overview for elapsed time, repeated tool-call warnings, and cautious model-fit hints. It stores derived signals only, sends no chat content and makes no AI/API calls; it cannot appear as a persistent Codex icon or always-on panel. Model hints are heuristic and never change the active model. Separately, the local Stop hook can review available transcripts and recorded tool activity after each completed agent turn with Jev. That optional feature requires `AI_GATEWAY_API_KEY`, sends conversation data to Vercel AI Gateway, and may incur charges. Local defaults cap use at 20 reviews and 350,000 trace bytes per UTC day, with duplicate invocations skipped. These limits reduce usage but do not guarantee a fixed dollar maximum. A Jev request can delay the end of a turn by up to eight seconds. Results are advisory; Jev never continues or closes work, creates issues, or takes actions. Set `MINDRAILS_JEV_AUTO_REVIEW=0` or disable the plugin to stop reviews.

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
