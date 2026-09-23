# Evidence and practical limits

`npm run evidence` separates three questions:

1. Does the implementation behave as specified through a real MCP client?
2. Do deterministic vetoes add anything beyond accepting the agent's own completion claim or checking declared host statuses?
3. Does Jev make good semantic judgments on real cases?

The first two are reproducible offline. The third was run once through Vercel's official TypeSafe-compatible route; the native TypeSafe route remains unrun because new dashboard registrations were unavailable.

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

These cases demonstrate that separate requirement, evidence, contradiction and host-check vetoes enforce the stated invariants. They do not demonstrate that a model will produce accurate signals, nor that the fixtures represent real-world prevalence.

## End-to-end mechanics

`npm run e2e` starts the packaged stdio server and uses the official MCP client. It checks discovery, premature completion, missing evidence, accepted synthetic completion, process-budget exhaustion, an alternating loop, repeat grace and grace exhaustion. It is a transport and policy test using the synthetic marker provider.

## Preparing one live Jev check

`npm run jev:suite:dry-run` prints all twelve frozen cases, labels and their fixture hash without making a network request. Execution is deliberately double gated:

```sh
MINDRAILS_ALLOW_PAID_JEV=I_UNDERSTAND_THIS_MAY_COST_MONEY \
TYPESAFE_API_KEY=... \
node evidence/jev-live-suite.mjs --execute
```

For Vercel's official TypeSafe-compatible route, also set `MINDRAILS_JEV_ROUTE=vercel-ai-gateway` and use `AI_GATEWAY_API_KEY` instead. That route reports the unversioned `typesafe-ai/jev` alias and must not be presented as a native `jev-1.13.0` result.

The live path makes at most twelve requests, never retries, reports provider token usage and separates false finishes, false continues, unexpected reviews and provider errors. Missing usage is counted and included in a conservative cost ceiling rather than treated as free. Native cost uses the documented $0.042 per million input tokens; the Vercel route uses the catalog rate of $0.04 per million, both checked on 2026-09-23. Output tokens are documented as free. Actual account terms and pricing control. No key is stored in the repository.

## Live gateway result

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

Every incomplete or contradicted case continued. All five expected finishes also continued, mainly because the provider assigned insufficient evidence under the current questions and 0.9 threshold. Since all twelve outputs were `continue`, the 7/12 score provides no improvement over an always-continue baseline. The result establishes live fail-closed connectivity, not useful recall; this configuration is not recommended as an automated stop gate. The sanitized row-level report is in [`evidence/results/jev-live-vercel-2026-09-23.json`](../evidence/results/jev-live-vercel-2026-09-23.json), SHA-256 `e9e4624b155405189effd26d79c989fee36c74e62c84e9e1874591217e0954ab`.

The official documentation also says English is the primary training language and lists weaknesses involving literal wording, numbers, indirection, irrelevant context and adversarial content. A useful semantic evaluation needs pre-labeled cases covering those boundaries; a single successful call would establish connectivity, not accuracy.
