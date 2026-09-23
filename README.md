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

For a direct check, select the provider explicitly. Unix: `MINDRAILS_PROVIDER=mock node dist/cli.js check examples/check.json`. PowerShell: `$env:MINDRAILS_PROVIDER='mock'; node dist/cli.js check examples/check.json`. The `stuck` command is deterministic and needs no provider.

`check <file.json>` returns an advisory decision. `stuck <file.json>` accepts `{ "steps": [{ "action": "search", "input": "q", "result": "same", "progress": false }] }`. Exit status 0 means the evaluation was returned successfully, including `continue` or `review`; the host must inspect `decision`. Invalid input/startup uses exit status 1.

## Two MCP tools

| Tool | Input | Result |
| --- | --- | --- |
| `check_completion` | task, currentResult, 1–20 unique requirements, supplied evidence; optional trustedChecks | finish / continue / review, reason codes, missing requirement IDs, raw model signals and provenance |
| `detect_stuck` | Up to 50 caller-supplied action/input/result/progress steps; optional `allowedExtraRepetitions` from 0–2 | At least three trailing repetitions of a one-to-three-step cycle, with zero-based matched indices |

Completion requires every requirement and task/evidence signal to reach 0.9, and contradiction signal at most 0.1. Supplied global evidence or evidence on every requirement is mandatory. Any declared `trustedChecks` entry with `fail` or `unknown` blocks completion. **Despite the field name, these checks are caller-declared, unauthenticated statuses.** An agent can lie about them; obtain checks from a trusted host boundary if you need enforcement.

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

## Optional Jev mode (BYOK)

Set `MINDRAILS_PROVIDER=jev` and supply `TYPESAFE_API_KEY` through your host's secret environment. Then use the same commands. The optional official Vercel compatibility route uses `MINDRAILS_JEV_ROUTE=vercel-ai-gateway` with `AI_GATEWAY_API_KEY`. Provider selection is mandatory for `check` and `mcp`, preventing an accidental synthetic default or billable default. Environment files are not loaded automatically. Do not put keys in committed configuration or command history.

Jev mode sends task, result, requirements and supplied evidence to the selected fixed HTTPS endpoint. Inference may incur charges under the selected account. The Apache license covers this software, not either service. See [TypeSafe's API](https://docs.typesafe.ai/api), [account terms](https://typesafe.ai/legal/mca), [data policies](https://docs.typesafe.ai/legal), and [Vercel's TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe). The native adapter pins `jev-1.13.0`; the gateway adapter pins Vercel's `typesafe-ai/jev` alias. Both verify the returned model and use Noul signals only. A gateway result does not establish which native Jev version served the alias.

The frozen twelve-case live suite was run once through Vercel's TypeSafe-compatible route on 2026-09-23: 12 requests, 7 correct, 0 false finishes, 5 false continues, and 0 provider errors. **All twelve outputs were `continue`, exactly matching an always-continue baseline at 7/12.** Provider-reported input was 6,185 tokens; the catalog-rate estimate was $0.0002474 and the account reported $0 current spend during the promotion. Jev mode is experimental and, at the fixed 0.9 threshold and current questions, is not recommended as an automated stop gate. See the [full sanitized result](evidence/results/jev-live-vercel-2026-09-23.json) and [method](docs/evidence.md).

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

Tests cover policy vetoes, bounds, timeouts, malformed responses, budgets, loop detection, CLI and actual MCP transport. `npm run e2e` prints ten concrete official-client scenarios. `npm run evidence` reproduces the fixed trace comparison and deterministic-policy baselines. The datasets are synthetic; no production accuracy, cost savings or performance benchmark is claimed. See [evidence](docs/evidence.md), [architecture](docs/architecture.md), [provenance](docs/provenance.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

v0.2 intentionally excludes hosted MCP, persistent run state, dashboards, routing and automatic actions. Feedback on incorrect decisions is welcome using synthetic or redacted examples. No npm registry publication is provided; use the repository or GitHub release package.

## License

New original code: [Apache-2.0](LICENSE). Dependencies retain their own licenses; see [NOTICE](NOTICE). This project is independent of TypeSafe and is not an official Jev product.
