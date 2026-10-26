# MindRails Supervisor

[![CI](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml/badge.svg)](https://github.com/haskallalk-eng/mindrails-supervisor/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Model advice and task checks for Claude Code, Codex and MCP hosts — a project by MindRails.**

MindRails Supervisor makes model advice, completion checks and repeated steps inspectable when working with coding agents. It combines plugins, a local chat app and MCP tools. Checks evaluate the requirements and evidence supplied by the host. Optional model-backed checks use [Jev](https://typesafe.ai); the offline demo works without an account or API key.

**My contribution:** I, Hassieb Kalla, developed the project with AI assistance, connecting model-advice plugins, a local agent app and MCP tools. The implementation includes shared provider configuration, input validation and tests for the decision paths. See [source and dependency provenance](docs/provenance.md).

[Offline demo](#try-the-free-offline-demo) · [Schritt-für-Schritt-Demo](docs/offline-walkthrough.md) · [Setup and technical reference](docs/supervisor-reference.md) · [Verification](docs/portfolio-validation.md) · [Hassieb Kalla's portfolio](https://github.com/haskallalk-eng)

**Deutsch:** Ein Entwicklungsprojekt von **Hassieb Kalla / MindRails**: Modellvorschläge und Aufgabenprüfungen für Coding-Agenten nachvollziehbar machen. Ich habe Plugins, lokale App und MCP-Werkzeuge mit KI-Unterstützung entwickelt und verbunden. Die Offline-Demo zeigt die Entscheidungslogik mit synthetischen Beispielen.

## Project status

**Working preview, October 2026.** The published features are available to try; there is no roadmap for additional features. Maintenance fixes, issues and pull requests are welcome.

Plugins recommend model changes; the Jev app can select models when starting its own agent runs. Completion checks advise the host based on the task and evidence supplied.

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

The demo uses explicit markers to exercise the decision rules. It makes no model calls.

[Follow the walkthrough](docs/offline-walkthrough.md) to inspect an input, read its JSON result and trace the decision back to the source.

## Choose an entry point

- **Try the behavior:** run the offline demo above.
- **Use the plugins or local app:** follow the [setup guide](docs/supervisor-reference.md#quick-start). Model-backed checks need your own provider key and may incur charges.
- **Integrate an MCP host:** see [tool contracts](docs/supervisor-reference.md#mcp-tools) and [MCP configuration](docs/supervisor-reference.md#mcp-setup).
- **Review the implementation:** start with [architecture](docs/architecture.md), [routing policy](docs/model-routing.md) and [evidence methodology](docs/evidence.md).

## Development and tests

```sh
npm test
npm run typecheck
npm run demo
npm run e2e
```

Tests cover completion decisions, input validation, conversation storage, CLI behavior and MCP transport. They use synthetic fixtures and stand-in agent processes. [Recorded test runs](docs/portfolio-validation.md) identify the tested revisions; [provider experiments](docs/supervisor-reference.md#optional-jev-mode-byok) are separate.

## Data and provider use

The offline demo needs no credentials. Jev mode sends the supplied task or conversation content to your configured provider and can incur charges. The local app stores conversations on disk. See [security and privacy](SECURITY.md) for the different storage paths.

Model advice is based on benchmark and community-evidence snapshots. Check recommendations against your own workload; the host remains responsible for permissions and execution.

[Full setup and commands](docs/supervisor-reference.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

Original code: [Apache-2.0](LICENSE). Dependencies retain their own terms; see [NOTICE](NOTICE) and [provenance](docs/provenance.md). Independent of TypeSafe; this is not an official Jev product.
