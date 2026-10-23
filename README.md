# MindRails Supervisor

[![CI](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Model advice and task checks for Claude Code, Codex and MCP hosts — a project by MindRails.**

MindRails Supervisor brings together a model-advice plugin, a local chat app and an MCP server for completion checks and repeat-loop detection. The optional model-backed checks use [Jev](https://typesafe.ai); the offline demo works without an account or API key.

[Offline demo](#try-the-free-offline-demo) · [Schritt-für-Schritt-Demo](docs/offline-walkthrough.md) · [Setup and technical reference](docs/supervisor-reference.md) · [Verification](docs/portfolio-validation.md) · [Hassieb Kalla's portfolio](https://github.com/haskallalk-eng)

**Deutsch:** Ein Projekt von **MindRails** für die Arbeit mit Coding-Agenten: passende Modelle vorschlagen, Aufgaben anhand vorgegebener Kriterien prüfen und wiederholte Arbeitsschritte erkennen. Die Offline-Demo unten zeigt die Entscheidungslogik anhand synthetischer Beispiele.

## Project status

**Finished preview, October 2026.** Complete as published and shared as a working reference, with no active development roadmap. Issues and pull requests are welcome.

The tools advise the host; they do not grant permissions or independently establish that a task succeeded. Plugins recommend model changes. The separate Jev app can select models when it starts agent runs itself.

## What's inside

| Component | Purpose | Source |
| --- | --- | --- |
| Jev plugins | Suggest model and effort before a new task; the user changes the model in the host | [Claude Code](plugins/jev-claude) · [Codex](plugins/jev-codex) |
| Jev app | Start Claude Code and Codex runs from a local chat window, with model selection and text-based handover | [App](src/jev-app) |
| Supervisor MCP server | Check supplied completion requirements, detect repeated steps and triage traces | [Server](src/cli.ts) · [MCP tools](docs/supervisor-reference.md#mcp-tools) |
| Codex review plugin | Local session monitoring and optional end-of-turn Jev review | [Plugin guide](plugins/jev-chat-review/README.md) |

## Try the free offline demo

Requires **Node.js 24+** and npm. No account, API key or model-provider request is needed.

```sh
git clone https://github.com/haskallalk-eng/mindrails-supervisor.git
cd mindrails-supervisor
npm ci --ignore-scripts
npm run build
npm run demo
```

Expected synthetic output:

```text
SYNTHETIC MOCK DEMO — no API call, no semantic evaluation
3/5 markers → CONTINUE license, security
5/5 markers → FINISH
3 repeated steps → REVIEW
changed result → CONTINUE
```

The demo runs the implementation with explicit markers and supplied fixtures. It demonstrates policy mechanics, **not model accuracy**.

[Follow the walkthrough](docs/offline-walkthrough.md) to inspect an input, read its JSON result and trace the decision back to the source.

## Choose an entry point

- **Try the behavior:** run the offline demo above.
- **Use the plugins or local app:** follow the [setup guide](docs/supervisor-reference.md#quick-start). Model-backed checks need your own provider key and may incur charges.
- **Integrate an MCP host:** see [tool contracts](docs/supervisor-reference.md#mcp-tools) and [MCP configuration](docs/supervisor-reference.md#mcp-setup).
- **Review the implementation:** start with [architecture](docs/architecture.md), [routing policy](docs/model-routing.md) and [evidence methodology](docs/evidence.md).

## Verification

[Reproduced locally on 23 October 2026](docs/portfolio-validation.md):

| Check | Result |
| --- | --- |
| Build and automated tests | 167 passed, 0 failed, 0 skipped |
| TypeScript | Passed |
| MCP transport scenarios | 12 passed |
| Offline demo | Documented decisions reproduced |

The complete test suite and TypeScript were rerun after the final storage fix. MCP scenarios and the offline demo were checked at the preceding code revision; the linked verification record identifies both commits and the scope of each check.

```sh
npm test
npm run typecheck
npm run demo
npm run e2e
```

These checks use synthetic fixtures; app tests use stand-in agent processes. They do not establish production accuracy, cost savings or a live end-to-end test of both coding agents. Separate provider experiments and their limits are documented in the [technical reference](docs/supervisor-reference.md#optional-jev-mode-byok).

## Data handling and limits

- The offline demo makes no model calls. Jev mode sends selected task, result or conversation content to the configured provider and can incur charges.
- The Jev app stores conversations locally; the assessment server and local monitoring have different storage behavior. See [security and privacy](SECURITY.md).
- Model advice uses documented benchmark and community-evidence snapshots. It is not a guarantee of the best model for every task.
- Completion decisions depend on supplied evidence. The host remains responsible for verification, permissions and execution.

[Full setup, commands, limits and evaluation details](docs/supervisor-reference.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

Original code: [Apache-2.0](LICENSE). Dependencies retain their own terms; see [NOTICE](NOTICE) and [provenance](docs/provenance.md). Independent of TypeSafe; this is not an official Jev product.
