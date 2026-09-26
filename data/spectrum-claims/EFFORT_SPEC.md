# Effort claim collection spec (read fully before searching)

Goal: collect as many **individual statements and measurements** as possible about which reasoning **effort level** works best for a specific model on a specific kind of task. Effort is NOT assumed to be comparable across models or vendors, so every claim must name one model. We will count and weight them (more credible and more concrete evidence weighs more).

## Models (use exactly these ids)
claude-fable-5-1, claude-fable-5, claude-opus-5-5, claude-opus-5, claude-opus-4-8, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5,
gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5-6-sol, gpt-5-6-terra, gpt-5-6-luna, gpt-5-5

## Effort levels (use exactly these ids)
low, medium, high, xhigh, max, ultra   (Claude: low…max; "Extra hoch" in the Claude app = xhigh. OpenAI/Codex: low…max plus ultra on some models.)

## Task types (same ids as CLAIM_SPEC.md)
implementation, agentic_terminal, debugging, architecture_planning, code_review, refactoring_migration, frontend_ui, research_knowledge, simple_edits, writing_docs, general (use general only when the statement is not task-specific)

## Output format (JSONL, one object per line)
{"model": "<id>", "task": "<task id>", "effort": "<effort id>", "verdict": "best|enough|too_little|too_much|worse_than_lower", "strength": 1|2|3, "compared_to": "<other effort id or empty>", "measure": "<number/metric if any, e.g. 'SWE-bench Pro -2.5 pts at 70% cost vs high', else empty>", "platform": "reddit|hn|x|youtube|github|blog|forum|news|vendor|paper|benchmark", "author_kind": "user|practitioner|vendor|press|researcher", "date": "YYYY-MM-DD or YYYY-MM", "quote": "<paraphrase, max 25 words, English>", "url": "<source url>"}

- verdict meanings: best = the recommended/optimal level for that model+task; enough = this level already suffices (higher brings nothing noticeable); too_little = quality clearly suffers at this level; too_much = wastes tokens/time without benefit, overthinks, scope creep; worse_than_lower = measured or observed quality is LOWER than at a lower level (non-monotonic).
- strength: 1 passing remark, 2 clear opinion from experience, 3 measured (benchmark table, A/B test, cost/quality numbers).
- author_kind: researcher = paper/benchmark org (e.g. Artificial Analysis, arXiv); practitioner = structured tests or tool-company data; user = individual developer; vendor = model maker (Anthropic, OpenAI).
- Include official vendor effort tables and independent per-effort benchmark results (e.g. Artificial Analysis index per effort level) as claims with strength 3, one claim per model+effort data point that implies a verdict.
- Different people saying the same thing = separate claims. Only material from 2026-06 onward. Never invent.
- Aim for at least 50 claims.

## Access tips (this sandbox)
- reddit.com cannot be fetched directly and WebSearch rarely returns reddit links. What works: WebFetch on https://search.brave.com/search?q=<query>+site%3Areddit.com (returns real thread titles, ids, snippets), and blogs that quote reddit threads.
- Hacker News: https://hn.algolia.com/api/v1/search?query=<q>&tags=comment (curl via Bash works).
- WebSearch has a per-agent budget; mix in WebFetch on search.brave.com result pages once searches run low.

At the end, write a 5-line summary to the matching .md file.
