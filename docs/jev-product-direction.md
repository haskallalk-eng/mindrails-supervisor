# Jev recovery advice: product direction

Reviewed 2026-09-24. Product hypothesis: a developer with several Codex tasks should get a useful next step when work stops progressing, and should not need to inspect every transcript to distinguish a bad approach from missing access or missing requirements.

## Actual Jev projects

These are primary repository descriptions, not independent performance measurements. No source code was copied.

| Project | Documented use of Jev | Implication for Mindrails |
| --- | --- | --- |
| [Bicameral](https://github.com/AbdelStark/bicameral) | Pi harness with typed judgments for tool gates, edit checks, stuck detection, template hints and a HUD | Loop detection plus Jev is already an existing idea. Our initial recovery feature is not a uniqueness claim. |
| [Codex Jev Router](https://github.com/suenot/codex-jev-router) | Jev-based selection for Codex subagent routing | Model selection alone is not a defensible differentiator. |
| [jev-harness](https://github.com/TypeSafeAI/jev-harness) | Independent community research contract: an LLM proposes, Jev answers narrow questions, host code owns decisions | Keep semantic judgment separate from application actions and record the actual decisions. |

## Why Jev belongs in the product

[TypeSafe's model documentation](https://docs.typesafe.ai/models) describes evaluating several typed questions against one shared state in parallel. We use that for completion, user outcome, run health, progress, blocker, next step, and optional model fit in one provider request. The new questions increase request tokens even though they do not add another API call. Token usage remains reported by the provider; there is no measured savings claim.

The new `recovery-v1` policy checks both confidence (at least 0.75) and selected-option probability (at least 0.8), then verifies the cause/action mapping. These are initial thresholds, not calibrated accuracy guarantees. Three agreeing model judgments are not independent verification. A mismatch produces an uncertain review without an actionable prompt. The retained signals explain which labels drove the policy; they do not identify independently verified source evidence.

Examples: an access failure selects an environment check; repeated ineffective attempts select a different hypothesis; unsupported success selects verification. Different test results after repeated test commands can still represent progress. For an environment, information, verification or requirements obstacle, a conflicting model-change suggestion is suppressed. The host never runs the suggested prompt automatically.

## Context and integration limits

The Codex adapter still rejects oversized traces rather than silently selecting excerpts: 48 KB, 120 visible messages, 50 tool calls and existing field caps. This release does not implement long-chat chunking. TypeSafe documents 64k tokens per full request and 32k for state plus the longest question; byte caps are application limits, not equivalent token limits. [Known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include irrelevant-context degradation and adversarial content. Jev cannot generate a prose summary for a chunked pipeline; that would require a different design or a text model.

Recovery advice is available in the MCP result and optional Codex Stop review. It does not add a persistent desktop icon, background timer, automatic model switch or autonomous recovery runner. Local monitoring can run without a key; semantic Jev review needs the user's configured gateway key and sends the supplied trace to that service. Mock mode does not pretend to diagnose real chats.

## What must demonstrate the additional value

The intended difference is an integrated diagnosis and next-step experience across existing Codex tasks, with model advice conditioned on the cause. The first implemented slice is cause/action agreement and a ready-to-use recovery prompt. To establish user value, evaluate false interventions during productive work, correct distinction of environment versus reasoning failures, accepted suggestions, and progress after a suggestion on representative real tasks. Outcome tracking and measured improvement after intervention are future work, not shipped features.

Run `node evidence/jev-recovery-suite.mjs` for the eight synthetic development fixtures without network access. Live execution additionally requires `--execute`, `AI_GATEWAY_API_KEY` and `MINDRAILS_ALLOW_PAID_JEV=I_UNDERSTAND_THIS_MAY_COST_MONEY`. It makes at most eight requests, with no automatic retry, stops on provider failure, and reports labels, policy actions, latency and token usage. This set is small and hand-authored, not a production benchmark. During this change the local key file was empty and no gateway key was configured, so no live result is claimed.
