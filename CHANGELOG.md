# Changelog

## Unreleased — local Jev calibration update

- Separate artifact completion from explicit source-backed `fact-check` mode; only fact-check mode hard-gates on supplied evidence.
- Adjust the initial signal threshold from 0.90 to 0.85 based on the five false continues in the first frozen Jev suite.
- Re-run the same twelve synthetic cases through Vercel Jev: 12/12 correct, no false finishes, false continues or provider errors; document that this tuned set is not held-out validation.
- Add a separate frozen eight-case held-out Jev check: 7/8 correct, zero false finishes, one false continue, zero provider errors; leave the policy unchanged after the run.
- Add a live sanitized result and update CLI, MCP examples, policy tests and documentation.

## 0.2.0 — 2026-09-23

- Detect trailing cycles of one to three steps, including A-B and A-B-C loops.
- Add a caller-declared, bounded repeat grace and report when it expires.
- Require an explicit provider for CLI and MCP operation; the demo stays explicitly synthetic.
- Correct mock evidence handling when every requirement supplies evidence.
- Surface Jev token usage separately from semantic signals.
- Add a real MCP scenario runner, fixed baseline evidence and a double-gated live Jev check.
- Add the official fixed Vercel TypeSafe-compatible Jev route with distinct model provenance.
- Document measured implementation gains and the first bounded live Jev gateway result (7/12, no false finishes or provider errors).

## 0.1.0 — 2026-09-23

- Add local completion policy and deterministic repeated-step detection.
- Provide JSON CLI and stdio MCP tools.
- Add offline synthetic demo and bounded host-loop example.
- Add optional Jev HTTP adapter with deadlines, request/response bounds and attempt/input budgets.
- Validate policy and actual MCP transport offline. Live Jev inference remains untested.
