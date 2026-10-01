# Claim collection spec (read fully before searching)

Goal: collect as many **individual statements** as possible where a person or organization says that a specific AI model is good or bad at a specific kind of task. We will later count them: the more independent people say the same thing, the stronger the signal. Quantity of distinct, real statements matters; do not summarize or merge them.

## Models (use exactly these ids)
claude-fable-5-1, claude-fable-5, claude-opus-5-5, claude-opus-5, claude-opus-4-8, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5,
gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-reserve, gpt-5-6-sol, gpt-5-6-terra, gpt-5-6-luna, gpt-5-5
(If a statement only names a family without version, e.g. "Opus", map it to the newest version current at the statement's date; if unclear, skip it.)

## Task types (use exactly these ids)
- implementation: writing new features/code in an existing repo
- agentic_terminal: long autonomous multi-step work, terminal, builds, tool use, running for a long time
- debugging: finding and fixing bugs
- architecture_planning: system design, planning, breaking down work, hard reasoning about code
- code_review: reviewing code, finding issues in diffs/PRs
- refactoring_migration: large refactors, framework/language migrations
- frontend_ui: UI, CSS, web design, visual quality
- research_knowledge: research, reading docs, explaining, analysis, knowledge work
- simple_edits: small edits, renames, quick questions, boilerplate
- writing_docs: prose, documentation, emails, specs
- cost_speed: statements that a model is cheap/fast/good value, or expensive/slow/wasteful (task-agnostic)

## Output format
Append one JSON object per line (JSONL) to your output file. Fields:
{"model": "<model id>", "task": "<task id>", "polarity": 1 or -1, "strength": 1|2|3, "comparative": "<other model id or empty>", "platform": "reddit|hn|x|youtube|github|blog|forum|news|vendor", "author_kind": "user|practitioner|vendor|press", "date": "YYYY-MM-DD or YYYY-MM", "quote": "<paraphrase, max 25 words, in English>", "url": "<source url>"}

- polarity: 1 = good at it / recommended for it, -1 = bad at it / not recommended.
- strength: 1 = passing remark, 2 = clear opinion, 3 = backed by a concrete test/experience with specifics.
- comparative: fill when the statement compares ("Opus 5.5 beats Fable 5.1 at X" → one claim for opus +1 comparative fable, and one claim for fable -1 comparative opus).
- author_kind: user = individual developer opinion; practitioner = someone who ran structured tests or a tool company sharing usage data; vendor = the model maker; press = journalists.
- One statement can yield several claims (several models or tasks). Different people saying the same thing = separate claims (that is the point). The same person repeating themselves = one claim.
- Only statements from 2026-06 onward (these models are new); skip anything older.
- Never invent statements. If search results only give a summary without an attributable statement, you may record it with strength 1 and the page url, but prefer real posts/comments.
- Aim for at least 40 claims; more is better. Stop when searches stop yielding new statements.

At the end, also write a 5-line summary to the matching .md file (which patterns appeared most often).
