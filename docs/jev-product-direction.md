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

The `recovery-v2` policy checks both confidence (at least 0.75) and selected-option probability (at least 0.8), then verifies the cause/action mapping. These are initial thresholds, not calibrated accuracy guarantees. Three agreeing model judgments are not independent verification. Uncertainty or disagreement selects `action: none`, retaining `status: uncertain` and the original signals. `CONTINUE_BASELINE` means the host follows its normal path, not that work is successful or that a stopped task must be restarted. Uncertainty alone stays quiet in the Stop hook. Clear failure, dissatisfaction and permission-violation signals remain visible. An incomplete task with no clear recovery intervention can keep its normal path.

Model advice is deliberately asymmetric at the user's request. A downgrade still requires confidence >= 0.65 and selected-option probability >= 0.75. An uncertain downgrade keeps the current model. An upgrade can be recommended as a `quality_fallback` if it is Jev's leading choice despite weak confidence, or if Jev selects uncertain but the upgrade probability is >= 0.25 and at least as high as either concrete alternative. Uncertainty with no such capability signal keeps the current model. This is a product preference for quality, not new model certainty or a proven benefit; stronger models may cost more. A clearly identified prerequisite obstacle vetoes switching even if progress is uncertain. Raw confidence is preserved and fallback wording is distinguished from Jev's own strong recommendation. Model changes are still advisory, not executed.

Examples: an access failure selects an environment check; repeated ineffective attempts select a different hypothesis; unsupported success selects verification. Different test results after repeated test commands can still represent progress. For an environment, information, verification or requirements obstacle, a conflicting model-change suggestion is suppressed. The host never runs the suggested prompt automatically.

## Context and integration limits

The Codex adapter still rejects oversized traces rather than silently selecting excerpts: 48 KB, 120 visible messages, 50 tool calls and existing field caps. This release does not implement long-chat chunking. TypeSafe documents 64k tokens per full request and 32k for state plus the longest question; byte caps are application limits, not equivalent token limits. [Known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include irrelevant-context degradation and adversarial content. Jev cannot generate a prose summary for a chunked pipeline; that would require a different design or a text model.

Recovery advice is available in the MCP result and optional Codex Stop review. It does not add a persistent desktop icon, background timer, automatic model switch or autonomous recovery runner. Local monitoring can run without a key; semantic Jev review needs the user's configured gateway key and sends the supplied trace to that service. Mock mode does not pretend to diagnose real chats.

## What must demonstrate the additional value

The intended difference is an integrated diagnosis and next-step experience across existing Codex tasks, with model advice conditioned on the cause. The first implemented slice is cause/action agreement and a ready-to-use recovery prompt. To establish user value, evaluate false interventions during productive work, correct distinction of environment versus reasoning failures, accepted suggestions, and progress after a suggestion on representative real tasks. Outcome tracking and measured improvement after intervention are future work, not shipped features.

Run `node evidence/jev-recovery-suite.mjs` for the eight synthetic development fixtures without network access. Live execution additionally requires `--execute`, `AI_GATEWAY_API_KEY` and `MINDRAILS_ALLOW_PAID_JEV=I_UNDERSTAND_THIS_MAY_COST_MONEY`. It makes at most eight requests, with no automatic retry, stops on provider failure, and reports labels, policy actions, latency and token usage. This set is small and hand-authored, not a production benchmark. The first live run is preserved in `evidence/results/jev-recovery-2026-09-24.json`: all eight requests succeeded; four original policy actions matched the expected actions and four abstained unexpectedly. Usage was 15,435 input and 3,266 output tokens, with observed request times of 270–1,080 ms. These figures do not establish production accuracy.

`node evidence/jev-baseline-replay.mjs` reuses those exact recorded Jev answers against the updated policy without API calls. The original semantic expectations remain visible, so a silent fallback is not counted as solving the missing verification or requirements mismatch. This is a policy regression comparison, not a fresh independent model evaluation.
