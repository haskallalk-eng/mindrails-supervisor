# Architecture and trust boundaries

MindRails Supervisor contains several components with different execution and storage behavior. The assessment engine returns advice. The Jev app starts coding-agent runs and stores conversations. Plugins and panels keep local state. These boundaries matter when deciding what data to submit and which permissions to grant.

## Components and source map

| Component | Responsibility | Execution and storage | Source |
| --- | --- | --- | --- |
| Assessment engine | Evaluate supplied completion requirements and detect repeated steps | Keeps process-local counters; does not execute the submitted task or persist assessment content | [Core policy](../src/core.ts) · [Providers](../src/providers.ts) |
| CLI and stdio MCP server | Validate inputs, expose assessments and return structured results | CLI assessment commands read the specified JSON file. The separate `open_codex_chats` MCP tool reads the configured plugin's local monitoring file | [CLI and MCP registrations](../src/cli.ts) |
| Model advice and trace triage | Recommend a model/effort or a next step from supplied context | Advice does not itself change the host's model or execute a follow-up prompt | [Routing policy](../src/model-policy.ts) · [Trace triage](../src/triage.ts) · [Model-routing guide](model-routing.md) |
| Jev app | Own conversations, choose a runner and hand over unseen history | Starts Claude Code or Codex, passes the selected model/effort, and writes local conversation records | [App](../src/jev-app/app.ts) · [Runners](../src/jev-app/runners.ts) · [Store](../src/jev-app/store.ts) |
| Codex review plugin | Track local run status and optionally request end-of-turn review | Monitoring and review coordination use local state files; optional model-backed review can send selected content to a provider | [Plugin guide](../plugins/jev-chat-review/README.md) · [Monitor state](../plugins/jev-chat-review/hooks/monitor-state.mjs) · [Review state](../plugins/jev-chat-review/hooks/review-state.mjs) |

## Completion assessment

```text
CLI JSON file or MCP input
  → schema validation
  → caller-declared host-check / required-evidence veto
  → process attempt and input-byte budgets
  → decision provider
  → signal validation
  → deterministic policy
  → advisory finish / continue / review
```

The provider is replaceable through the narrow `DecisionProvider` interface in [core.ts](../src/core.ts). The mock implementation reads synthetic markers. Jev evaluates one question per requirement plus task fulfillment, evidence sufficiency and contradictions in one request. Internal question keys are independent of user IDs.

The [Jev adapter](../src/providers.ts) selects a fixed native TypeSafe endpoint or a fixed Vercel TypeSafe-compatible endpoint. It does not accept a caller-supplied base URL. The adapter has no automatic retry layer. Provider mode sends the supplied assessment content off the machine; the offline mock does not make a model request.

Completion policy version `0.1.2` evaluates each requirement separately. `artifact` mode is the default and assesses whether requested content appears in the supplied result. `fact-check` mode requires supplied evidence and applies the evidence signal as an additional veto. Neither mode authenticates external claims or sources. The initial threshold is `0.85` for requirements/task and fact-check evidence, with a maximum contradiction signal of `0.1`; these are policy settings, not calibrated accuracy guarantees.

Declared `trustedChecks` with `fail` or `unknown` block completion. Despite the field name, these are caller-supplied statuses, not authenticated test results. The host must obtain trustworthy check results and control the selected evidence mode when those decisions matter. A `finish` response accepts the supplied information under this policy; it does not prove the underlying task succeeded.

Transport errors, invalid provider responses and exhausted budgets produce `review`. Timeouts abort provider requests. A custom provider that ignores `AbortSignal` may continue background work, so provider implementations must honor cancellation.

## Process limits and repeat detection

Call and serialized-input-byte budgets apply to each `Supervisor` instance/process. The CLI starts a new process for each command; a running MCP server retains its counters. These limits do not measure monetary charges and do not survive restarts. Durable quotas, overall deadlines and final permissions belong to the host.

[Repeat detection](../src/core.ts) checks the caller-supplied action/input/result trace for at least three trailing repetitions of a one-to-three-step cycle without reported progress. The caller can request up to two additional repetitions. This is an exact-pattern rule: changed results, reported progress and longer or semantically equivalent cycles can evade it. It does not verify that polling or progress is legitimate.

## Local app execution and handover

The [Jev app](../src/jev-app/app.ts) listens on `127.0.0.1` and checks a local access token. Its [runners](../src/jev-app/runners.ts) use the installed Claude Code program and Codex app-server. Model and effort are selected when a run starts; this differs from a plugin that only recommends a change inside an existing host session.

The app passes an access mode to the runner: Claude uses `default` or `acceptEdits`, while newly created Codex threads use `read-only` or `workspace-write`. Runner approval requests are shown in the app. The coding-agent host's permissions and session configuration remain part of the execution boundary; an assessment result does not grant permission to execute commands or change files.

The [handover logic](../src/jev-app/route.ts) forwards history that the selected agent has not yet seen as text. Older history may be shortened or omitted to meet its budget. This is conversation transfer, not migration of a provider's internal state. Agent runs may read or change the selected workspace within their effective permissions.

## Data persistence and privacy

The **completion assessment path** does not persist submitted content. That property does not apply to the whole repository:

- The [conversation store](../src/jev-app/store.ts) writes JSON files under `app/conversations` in the app state directory. Records include message text, workspace path, activity summaries and agent session identifiers.
- The [app server](../src/jev-app/app.ts) also stores its local access token. The default state location is selected by [state-dir.ts](../src/state-dir.ts) and can be overridden with `JEV_PANEL_HOME`.
- The review plugin writes monitoring and review coordination state in its plugin data directory. `open_codex_chats` reads monitoring state; it does not open a browser tab or send a model request.
- Configured providers and coding-agent hosts have their own data handling and logging behavior. Model-backed assessment, routing or review can send selected task or conversation content to those services.

Keep local state directories out of public repositories and shared backups. Stdio MCP is intended for a local host process; do not expose it through an unauthenticated network proxy. See [security and privacy](../SECURITY.md) for reporting and operational guidance.

## Evidence and limits

[Core tests](../tests/core.test.mjs) exercise policy decisions, input bounds and error paths. [MCP tests](../tests/mcp.test.mjs) and [transport examples](../examples/mcp-e2e.mjs) exercise local tool transport. [App tests](../tests/jev-app.test.mjs) use stand-in agent processes; they do not establish live Claude Code/Codex interoperability or production performance.

The [verification record](portfolio-validation.md) names the checked revision and commands. The [evidence methodology](evidence.md) separates synthetic policy checks from provider experiments. This is a finished preview with no guaranteed maintenance schedule, not a production certification.
