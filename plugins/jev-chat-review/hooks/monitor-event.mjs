import { recordMonitorEvent, recordMonitorUsage } from './monitor-state.mjs';
import { readLatestTokenTelemetry } from './codex-transcript.mjs';

let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 128_000) process.exit(0);
}
try {
  const event = JSON.parse(raw);
  const result = await recordMonitorEvent(process.env.PLUGIN_DATA, event);
  let usageRecommendations=[];
  if (event.hook_event_name === 'Stop' && event.transcript_path) {
    const telemetry=await readLatestTokenTelemetry(event.transcript_path);
    if(telemetry.tokenUsage||telemetry.rateLimits) usageRecommendations=(await recordMonitorUsage(process.env.PLUGIN_DATA,event.session_id,telemetry.tokenUsage,telemetry.rateLimits)).recommendations ?? [];
  }
  const recommendations=[...(result.recommendations ?? []),...usageRecommendations];
  if (event.hook_event_name === 'Stop' && recommendations.length) {
    process.stdout.write(`${JSON.stringify({ systemMessage: `Jev Chat-Monitor (lokal): ${[...new Set(recommendations)].join(' ')}` })}\n`);
  }
} catch {
  // Monitoring is best-effort and must never interrupt a Codex turn.
}
