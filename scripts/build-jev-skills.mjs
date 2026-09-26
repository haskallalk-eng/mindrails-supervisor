// Writes Jev's Claude plugin skills (plugins/jev-claude/skills) from the ids the
// hook uses (dist/jev-hook.js). Each skill only sets `model` or `effort`, which
// Claude Code applies to the rest of the current message. Frontmatter stays within
// the fields Claude Code treats as safe, so invoking them needs no permission prompt.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_EFFORTS, SKILL_MODELS, effortSkill, modelSkill } from '../dist/jev-hook.js';
import { MODEL_FACTS } from '../dist/model-benchmarks.js';
import { EFFORTS } from '../dist/chat-inspect.js';

const root = join('plugins', 'jev-claude', 'skills');
rmSync(root, { recursive: true, force: true });
const write = (name, fields, body) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), ['---', `name: ${name}`, ...fields, 'user-invocable: false', '---', body, ''].join('\n'));
};
const bare = skill => skill.slice('jev:'.length);

for (const [key, id] of Object.entries(SKILL_MODELS)) {
  const label = MODEL_FACTS[key].label;
  write(bare(modelSkill(key)), [`description: Nur auf Anweisung des Jev-Plugins aufrufen. Der Rest dieser Nachricht läuft auf ${label}.`, `model: ${id}`],
    `Jev: Der Rest dieser Nachricht läuft auf ${label}. Mach direkt mit der Aufgabe weiter, ohne das zu erwähnen.`);
}
for (const effort of SKILL_EFFORTS) {
  const label = `${EFFORTS.find(e => e.id === effort).label} (${effort})`;
  write(bare(effortSkill(effort)), [`description: Nur auf Anweisung des Jev-Plugins aufrufen. Setzt den Effort für den Rest dieser Nachricht auf ${label}.`, `effort: ${effort}`],
    `Jev: Der Effort für den Rest dieser Nachricht ist jetzt ${label}. Mach direkt mit der Aufgabe weiter, ohne das zu erwähnen.`);
}
console.log(`jev skills: ${Object.keys(SKILL_MODELS).length} model, ${SKILL_EFFORTS.length} effort -> ${root}`);
