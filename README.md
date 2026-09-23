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
node dist/cli.js check examples/check.json
node examples/agent-loop.mjs
node dist/cli.js mcp
```

`check <file.json>` returns an advisory decision. `stuck <file.json>` accepts `{ "steps": [{ "action": "search", "input": "q", "result": "same", "progress": false }] }`. Exit status 0 means the evaluation was returned successfully, including `continue` or `review`; the host must inspect `decision`. Invalid input/startup uses exit status 1.

## Two MCP tools

| Tool | Input | Result |
| --- | --- | --- |
| `check_completion` | task, currentResult, 1–20 unique requirements, supplied evidence; optional trustedChecks | finish / continue / review, reason codes, missing requirement IDs, raw model signals and provenance |
| `detect_stuck` | Up to 50 caller-supplied action/input/result/progress steps | Three identical trailing steps without reported progress, with zero-based matched indices |

Completion requires every requirement and task/evidence signal to reach 0.9, and contradiction signal at most 0.1. Supplied global evidence or evidence on every requirement is mandatory. Any declared `trustedChecks` entry with `fail` or `unknown` blocks completion. **Despite the field name, these checks are caller-declared, unauthenticated statuses.** An agent can lie about them; obtain checks from a trusted host boundary if you need enforcement.

`finish` means this policy accepts the supplied information. It does not establish real-world success. Evidence is not fetched or independently verified. Thresholds are initial policy defaults, not calibrated guarantees. Changed results or reported progress interrupt repeat detection; semantic loops may go undetected.

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

Set `MINDRAILS_PROVIDER=jev` and supply `TYPESAFE_API_KEY` through your host's secret environment. Then use the same commands. Environment files are not loaded automatically. Do not put keys in committed configuration or command history.

Jev mode sends task, result, requirements and supplied evidence to TypeSafe's fixed HTTPS endpoint. Inference may incur charges under your TypeSafe account. The Apache license covers this software, not the Jev service. See [TypeSafe's API](https://docs.typesafe.ai/api), [account terms](https://typesafe.ai/legal/mca) and [data policies](https://docs.typesafe.ai/legal). The adapter pins `jev-1.13.0`, verifies the returned model and uses Noul signals only. **Live Jev inference has not been exercised for this release**; transport contract tests use synthetic responses.

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

Tests cover policy vetoes, bounds, timeouts, malformed responses, budgets, loop detection, CLI and actual MCP transport. The dataset is synthetic; no accuracy, cost savings or performance benchmark is claimed. See [architecture](docs/architecture.md), [provenance](docs/provenance.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

v0.1 intentionally excludes hosted MCP, persistent run state, dashboards, routing and automatic actions. Feedback on incorrect decisions is welcome using synthetic or redacted examples. No npm registry publication is provided; use the repository or GitHub release package.

## License

New original code: [Apache-2.0](LICENSE). Dependencies retain their own licenses; see [NOTICE](NOTICE). This project is independent of TypeSafe and is not an official Jev product.
