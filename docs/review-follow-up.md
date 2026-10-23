# Review follow-up: truthful activity and recoverable storage

23 October 2026. These changes follow an automated, independent review of the
public implementation. This is engineering evidence, not a claim of human team
review, customer outcomes or production reliability.

## Tool activity must describe an observed outcome

Previously, a Claude `tool_use` request was recorded as an executed command or
changed file even when permission was denied. A test expected that incorrect
description. Activity is now tracked by tool ID through requested, allowed,
denied, completed and failed states. A request or permission alone cannot create
a success statement. Denial remains terminal even if an error result follows.

The same distinction applies to imported Claude conversations and to context
passed between agents. Unresolved or failed work remains visible even when a run
produces no answer text. Tests cover denials, successful and failed results,
missing results, out-of-order tool IDs, import and agent handoff.

- [State tracking](../src/jev-app/activity.ts)
- [Runner and handoff regression tests](../tests/jev-app.test.mjs)
- [Import/context regression tests](../tests/jev-panel.test.mjs)

Old stored activity strings cannot be reliably reclassified when the original
tool results are unavailable. Consumers should inspect the actual file state
before relying on historical success statements.

## Corrupt conversation files must not break the list or disappear

The store previously parsed JSON without validating its structure. A valid JSON
file with `messages: null` could crash the conversation list. It now validates
messages, timestamps, identity, access mode and per-agent history offsets.
Invalid files are skipped with a visible warning; their contents remain intact.
Saving a stale valid in-memory copy over a corrupt existing file is refused.
Unknown metadata is retained for forward compatibility.

- [Persistence boundary](../src/jev-app/store.ts)
- [Malformed-record and preservation tests](../tests/jev-store.test.mjs)

## Dependency maintenance and verification

MCP client/server are pinned to 2.3.1. The previous dependency audit reported two
high-severity affected packages; the updated audit reported zero findings.
The examined advisories concern HTTP/OAuth paths and exclude stdio. This project
uses stdio, so the update is dependency maintenance, not evidence that the
published application was exploitable. Adding HTTP later requires its own
transport-specific limits and review.

The follow-up passed 165 automated tests with no failures or skips, TypeScript,
the offline demo, 12 MCP scenarios, evidence generation, the live-suite dry-run
and package preparation. See the [verification record](portfolio-validation.md).
Agent compatibility was exercised with synthetic CLI fixtures; no paid live
agent run or production service was used.
