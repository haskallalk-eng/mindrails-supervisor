# Evidence and practical limits

`npm run evidence` separates three questions:

1. Does the implementation behave as specified through a real MCP client?
2. Do deterministic vetoes add anything beyond accepting the agent's own completion claim or checking declared host statuses?
3. Does Jev make good semantic judgments on real cases?

The first two are reproducible offline. The semantic suite was run twice through Vercel's official TypeSafe-compatible route: first to measure the original policy and then after a policy adjustment. The native TypeSafe route remains unrun because new dashboard registrations were unavailable.

## Fixed trace cases

Twelve hand-labeled cases were fixed during independent review of v0.1 before the candidate results were read. They are small boundary examples, not production traffic.

| Detector | TP | FP | FN | TN |
| --- | ---: | ---: | ---: | ---: |
| v0.1 exact-three detector | 1 | 2 | 4 | 5 |
| v0.2 default | 3 | 2 | 2 | 5 |

The candidate adds trailing cycles of length two and three. Two known misses remain: a four-stage cycle and errors whose timestamps change every result string. The same unchanged inputs retain two false alarms for identical polling and health traces because a trace alone cannot establish whether they are legitimate.

A separate configured-grace check shows three identical polls continue with `allowedExtraRepetitions: 2`, while five request review. This is a bounded caller declaration, not semantic proof that repetition is legitimate. An untrusted agent can request the allowance; hosts must own durable limits.

## Completion-policy fixtures

Six predeclared fixtures isolate deterministic policy composition. Fixed signals are used; they are not Jev outputs.

| Decision method | Correct fixtures |
| --- | ---: |
| Accept the agent's completion claim | 1 / 6 |
| Declared host checks only | 3 / 6 |
| Supervisor deterministic policy | 6 / 6 |

These cases demonstrate the deterministic handling of requirements, explicit fact-check evidence, contradictions and host-check vetoes. Artifact mode does not make external evidence claims. They do not demonstrate that a model will produce accurate signals, nor that the fixtures represent real-world prevalence.

## End-to-end mechanics

`npm run e2e` starts the packaged stdio server and uses the official MCP client. It checks discovery, premature completion, missing evidence, accepted synthetic completion, process-budget exhaustion, an alternating loop, repeat grace and grace exhaustion. It is a transport and policy test using the synthetic marker provider.

## Preparing one live Jev check

`npm run jev:suite:dry-run` prints all twelve frozen cases, labels, evidence mode and their fixture hash without making a network request. Ordinary output checks use artifact mode; the contradicted test-report case uses fact-check mode. Execution is deliberately double gated:

```sh
MINDRAILS_ALLOW_PAID_JEV=I_UNDERSTAND_THIS_MAY_COST_MONEY \
TYPESAFE_API_KEY=... \
node evidence/jev-live-suite.mjs --execute
```

For Vercel's official TypeSafe-compatible route, also set `MINDRAILS_JEV_ROUTE=vercel-ai-gateway` and use `AI_GATEWAY_API_KEY` instead. That route reports the unversioned `typesafe-ai/jev` alias and must not be presented as a native `jev-1.13.0` result.

The live path makes at most twelve requests, never retries, reports provider token usage and separates false finishes, false continues, unexpected reviews and provider errors. Missing usage is counted and included in a conservative cost ceiling rather than treated as free. Native cost uses the documented $0.042 per million input tokens; the Vercel route uses the catalog rate of $0.04 per million, both checked on 2026-09-23. Output tokens are documented as free. Actual account terms and pricing control. No key is stored in the repository.

## Initial live gateway result

The frozen fixture hash `11511c299e8b43a3c53fa9b2efaa6eb3dd6d227e68106feb476760146c146f2d` was executed once on 2026-09-23 through `https://ai-gateway.vercel.sh/typesafe/v1/systemone` with model alias `typesafe-ai/jev`.

| Measure | Result |
| --- | ---: |
| Requests | 12 |
| Correct | 7 |
| Always-continue baseline | 7 correct |
| False finishes | 0 |
| False continues | 5 |
| Provider errors | 0 |
| Provider-reported input tokens | 6,185 |
| Catalog-rate estimate | $0.0002474 |
| Vercel account current spend after run | $0 |

Every incomplete or contradicted case continued. All five expected finishes also continued, mainly because the provider assigned insufficient evidence under the original questions and 0.9 threshold. Since all twelve outputs were `continue`, the 7/12 score provided no improvement over an always-continue baseline. This first run exposed that ordinary artifact review was incorrectly gated on external evidence.

## Follow-up after the policy adjustment

The fix distinguishes reviewing whether a requested artifact contains the requested material from fact-checking claims against supplied sources. `artifact` is the default; `fact-check` requires global evidence or evidence on each requirement and applies Jev's evidence signal as a hard gate. The initial completion threshold changed from 0.90 to 0.85 after the fixed set showed completed requirements scoring 0.87–0.88. The contradictory test-log case explicitly uses `fact-check`; the other cases evaluate artifact completion.

On 2026-09-24, the same twelve labeled scenarios were run through the Vercel route again. Jev produced 5 `finish` and 7 `continue` decisions, matching all expected labels: **12/12, zero false finishes, zero false continues and zero provider errors**. It used 7,054 input and 1,024 output tokens; the catalog-rate estimate was $0.00028216. The sanitized row-level report is in [`evidence/results/jev-live-vercel-2026-09-24.json`](../evidence/results/jev-live-vercel-2026-09-24.json), SHA-256 `62e37431648c9b5764cf528ebee5c08ec49ec5c1a036bda5252d38ef7e094059`.

This result demonstrates that the revised policy can separate these twelve hand-authored cases. The policy and prompt were adjusted after seeing the first run, so the follow-up is tuned evidence rather than an independent validation set. Do not infer production accuracy or use it as a sole authorization control. The Vercel alias also does not establish which native Jev version served the call.

The official documentation also says English is the primary training language and lists weaknesses involving literal wording, numbers, indirection, irrelevant context and adversarial content. A useful semantic evaluation needs pre-labeled cases covering those boundaries; a single successful call would establish connectivity, not accuracy.
