# Technical verification – Mindrails Supervisor

Checked on **22 October 2026** in a clean checkout with Node.js 24.19.0. Source revision: `a54b5ac32e63dd8331ec55ed74dd7fd7fad7add1`.

| Check | Result |
| --- | --- |
| Build and automated tests (`npm test`) | 133 passed, 0 failed, 0 skipped |
| TypeScript (`npm run typecheck`) | Passed |
| Offline demonstration (`npm run demo`) | Completed with the documented continue/finish/review decisions |
| MCP transport (`npm run e2e`) | 12 scenarios passed, 0 failed |

## Reproduce

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run demo
npm run e2e
```

The offline demonstration and MCP scenarios use **synthetic fixtures**. They exercise the actual implementation and local MCP transport, but do not measure model accuracy or call a paid model provider. The automated app tests use stand-in Claude and Codex processes; this run did not perform live model routing or execute either real coding agent.

The CLI help and MCP handshake now identify package version 0.8.0 consistently. Regression assertions compare both surfaces with `package.json`. The [offline walkthrough](offline-walkthrough.md) includes captured output and the input file used.

The security documentation was also corrected to distinguish the stateless assessment path from the Jev app, which stores conversations locally. No production or provider configuration was changed.

[README](../README.md) · [CI](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml)
