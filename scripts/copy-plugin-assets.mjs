// Copies what the bundled Jev hook needs next to it (the Jev figure) into both plugins.
import { copyFileSync } from 'node:fs';

for (const dir of ['plugins/jev-claude/hooks', 'plugins/jev-codex/hooks']) copyFileSync('src/jev-badge.ps1', `${dir}/jev-badge.ps1`);
