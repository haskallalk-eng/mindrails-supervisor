# Mindrails Supervisor v0.2.0

A local MCP completion gate and repeated-step detector for AI agents.

- `check_completion` applies explicit per-requirement thresholds, optional source-backed fact-checking and declared-check vetoes, with inspectable signals and provenance.
- `detect_stuck` flags repeated trailing cycles of one to three steps without reported progress and supports at most two caller-declared grace cycles.
- JSON CLI, stdio MCP, offline synthetic demo and bounded host-loop example.
- Optional BYOK Jev adapter; one bounded request, no retries, sanitized failures, token-usage reporting and process budgets.

On the unchanged fixed 12-case v0.1 review set, trace detection changed from TP 1 / FP 2 / FN 4 / TN 5 to TP 3 / FP 2 / FN 2 / TN 5. The two remaining misses are a four-stage cycle and timestamp-changing error strings; identical polling and health traces remain false alarms by default. A separate bounded-grace example avoids those alarms until its declared allowance expires. These hand-labeled boundary cases are not production prevalence or a business-impact benchmark.

Free software and offline demo. Jev inference is a separate service and may cost money. The native `jev-1.13.0` route was not exercised because new TypeSafe dashboard registrations were unavailable. The Vercel `typesafe-ai/jev` route first scored 7/12 on twelve synthetic cases, with every output `continue`. After separating artifact completion from explicit fact-check mode and lowering the threshold to 0.85, the same labeled suite scored 12/12. A separate, frozen eight-case set scored 7/8 with no false finishes and one conservative false continue on valid JSON. These are small hand-authored evaluations, not production validation. Actual MCP stdio integration is tested with the official client. Other hosts are not advertised as verified.

This is an advisory utility. Evidence, checks and repeat grace are supplied by the caller; a finish decision does not independently verify success or authorize actions. No hosted service, telemetry, persistent run state, automatic model routing or npm registry publication. Provider choice is now mandatory for check/MCP commands so synthetic marker evaluation cannot be selected silently.

Use the source checkout with Node 24+ and `npm ci --ignore-scripts`, `npm run build`, `npm run demo`, or install the attached package locally. Apache-2.0 for original code; dependencies and TypeSafe service terms remain separate.

By [Mindrails](https://mindrails.de).
