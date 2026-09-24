import { recordMonitorEvent } from './monitor-state.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 128_000) process.exit(0);
}
try {
  const event = JSON.parse(raw);
  const result = await recordMonitorEvent(process.env.PLUGIN_DATA, event);
  if (result.recommendationCount > 0) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Jev chat monitor: ${result.recommendationCount} Hinweis(e) verfügbar. Öffne im Jev-Bereich „Offene Chats“ für die lokale Übersicht.` })}\n`);
  }
} catch {
  // Monitoring is best-effort and must never interrupt a Codex turn.
}
