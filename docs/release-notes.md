# Mindrails Supervisor v0.1.0

A local MCP completion gate and repeated-step detector for AI agents.

- `check_completion` applies explicit per-requirement thresholds, evidence and declared-check vetoes, with inspectable signals and provenance.
- `detect_stuck` flags three unchanged trailing steps without reported progress.
- JSON CLI, stdio MCP, offline synthetic demo and bounded host-loop example.
- Optional BYOK Jev adapter; one bounded request, no retries, sanitized failures and process budgets.

Free software and offline demo. Jev inference is a separate service and may cost money. Live Jev inference was not exercised for this release; adapter tests use synthetic HTTP responses. Actual MCP stdio integration is tested with the official client. Other hosts are not advertised as verified.

This is an advisory utility. Evidence and checks are supplied by the caller; a finish decision does not independently verify success or authorize actions. No hosted service, telemetry, persistent run state, automatic model routing or npm registry publication.

Use the source checkout with Node 24+ and `npm ci --ignore-scripts`, `npm run build`, `npm run demo`, or install the attached package locally. Apache-2.0 for original code; dependencies and TypeSafe service terms remain separate.

By [Mindrails](https://mindrails.de).
