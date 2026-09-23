# Changelog

## 0.2.0 — 2026-09-23

- Detect trailing cycles of one to three steps, including A-B and A-B-C loops.
- Add a caller-declared, bounded repeat grace and report when it expires.
- Require an explicit provider for CLI and MCP operation; the demo stays explicitly synthetic.
- Correct mock evidence handling when every requirement supplies evidence.
- Surface Jev token usage separately from semantic signals.
- Add a real MCP scenario runner, fixed baseline evidence and a double-gated live Jev check.
- Document measured implementation gains and unresolved semantic-model validation.

## 0.1.0 — 2026-09-23

- Add local completion policy and deterministic repeated-step detection.
- Provide JSON CLI and stdio MCP tools.
- Add offline synthetic demo and bounded host-loop example.
- Add optional Jev HTTP adapter with deadlines, request/response bounds and attempt/input budgets.
- Validate policy and actual MCP transport offline. Live Jev inference remains untested.
