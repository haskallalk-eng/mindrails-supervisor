# Technical verification – Mindrails Supervisor

Checked on **23 October 2026** after a clean dependency installation with Node.js 24.16.0. Code and regression-test revision: [`961d550`](https://github.com/haskallalk-eng/mindrails-supervisor/commit/961d550ee2db669b34f94e0a7c98157babe7fc2f). Later documentation commits do not change that tested code.

| Check | Result |
| --- | --- |
| Build and automated tests (`npm test`) | 165 passed, 0 failed, 0 skipped |
| TypeScript (`npm run typecheck`) | Passed |
| Offline demonstration (`npm run demo`) | Completed with the documented continue/finish/review decisions |
| MCP transport (`npm run e2e`) | 12 scenarios passed, 0 failed |
| Evidence / live-suite dry-run | Passed offline |
| Package preparation (`npm pack`) | Passed |
| Dependency audit | 0 findings after updating MCP client/server to 2.3.1 |

## Reproduce

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run demo
npm run e2e
npm run evidence
npm run jev:suite:dry-run
npm pack
npm audit
```

The offline demonstration and MCP scenarios use **synthetic fixtures**. They exercise the actual implementation and local MCP transport, but do not measure model accuracy or call a paid model provider. The automated app tests use stand-in Claude and Codex processes; this run did not perform live model routing or execute either real coding agent.

The CLI help and MCP handshake now identify package version 0.8.0 consistently. Regression assertions compare both surfaces with `package.json`. The [offline walkthrough](offline-walkthrough.md) includes captured output and the input file used.

The security documentation was also corrected to distinguish the stateless assessment path from the Jev app, which stores conversations locally. No production or provider configuration was changed.

The [review follow-up](review-follow-up.md) maps the additional tests to truthful tool status, corrupted-file handling and dependency maintenance. Earlier verification on 22 October counted 133 tests; the count above is the fresh follow-up run, not an inferred total.

[README](../README.md) · [CI](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml)
