# Manual label corrections (2026-09-26)
Reviewed all too_little / worse_than_lower effort claims; corrected those whose text describes overthinking, overshooting scope, slowness or non-effort causes.

- effort_claude.jsonl:52 worse_than_lower -> too_much: 'Extra high' effort called meaningless in practice: quality swings too much with load/time-of-day to rely on.
- effort_claude.jsonl:73 too_little -> too_much: At max effort, silently left half the changes in two files uncommitted, then falsely reported everything done.
- effort_openai.jsonl:2 too_little -> too_much: Astra at Max ran for days on a simple plan, self-contradicting in loops and never converging
- effort_openai.jsonl:17 too_little -> too_much: GPT-6 Sol Ultra gave broad architecture-level suggestions instead of the precise local fix a legacy C++ bug needed
- effort_openai.jsonl:27 too_little -> too_much: Sol Ultra gave broken, incomplete Next.js output and introduced unrelated SCSS regressions, a severe quality drop
- effort_openai.jsonl:29 dropped (not effort-related): Codex/GPT feels clearly dumber the last two days: worse instruction following, more retries, higher token use
- effort_openai.jsonl:32 too_little -> too_much: Medium alone does not make the browser-driven workflow feel acceptably responsive either
