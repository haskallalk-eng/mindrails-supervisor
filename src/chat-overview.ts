import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const MINUTE_MS = 60_000;
const RETAIN_MS = 24 * 60 * MINUTE_MS;
const LONG_TURN_MS = 10 * MINUTE_MS;
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const count = z.number().int().nonnegative();

const sessionSchema = z.object({
  id: z.string().min(1),
  project: z.string().default('Codex'),
  model: z.string().default(''),
  status: z.enum(['idle', 'working', 'waiting', 'ended']),
  startedAt: timestamp,
  updatedAt: timestamp,
  turnStartedAt: timestamp.nullish(),
  lastTurnMs: count.nullish(),
  toolCount: count.default(0),
  loopCount: count.default(0),
  actions: z.array(z.object({ signature: z.string().min(1) })).default([]),
  latestUsage: z
    .object({
      inputTokens: count.optional(),
      cachedInputTokens: count.optional(),
      outputTokens: count.optional(),
      reasoningOutputTokens: count.optional(),
      totalTokens: count,
      contextWindow: z.number().int().positive().nullable(),
    })
    .nullish(),
  rateLimits: z
    .object({
      primaryUsedPercent: z.number().min(0).max(100).nullable(),
      secondaryUsedPercent: z.number().min(0).max(100).nullable(),
    })
    .nullish(),
});

const monitorStateSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionSchema),
});
type MonitorSession = z.infer<typeof sessionSchema>;

function sessionRecommendations(session: MonitorSession, now: number): string[] {
  const hints: string[] = [];
  const started = session.turnStartedAt ? Date.parse(session.turnStartedAt) : NaN;
  if (session.status === 'working' && now - started >= LONG_TURN_MS) {
    hints.push(
      'Dieser Durchlauf läuft seit über 10 Minuten. Prüfe den letzten sichtbaren Fortschritt und gib bei Bedarf einen klaren nächsten Schritt.',
    );
  } else if (session.status === 'waiting' && (session.lastTurnMs ?? 0) >= LONG_TURN_MS) {
    hints.push(
      `Der letzte Durchlauf dauerte ${Math.floor(session.lastTurnMs! / MINUTE_MS)} Minuten. Prüfe, ob du den Auftrag künftig in klare Zwischenziele teilen möchtest.`,
    );
  }
  const recent = session.actions.slice(-3);
  if (recent.length === 3 && recent.every((action) => action.signature === recent[0]!.signature)) {
    hints.push(
      'Die letzten drei Tool-Aufrufe wiederholen dieselbe Aktion. Prüfe Ergebnis und ändere den Ansatz.',
    );
  }
  if (session.loopCount >= 2) {
    hints.push(
      'Dieselbe Tool-Aktion mit demselben Ergebnis wiederholte sich mehrfach. Ändere zuerst den Ansatz; Wiederholung allein belegt nicht, dass ein anderes Modell hilft.',
    );
  }
  return hints;
}

export function buildChatOverview(raw: unknown, now = Date.now()) {
  const state = monitorStateSchema.parse(raw);
  const chats = state.sessions
    .filter(
      (session) => session.status !== 'ended' && now - Date.parse(session.updatedAt) < RETAIN_MS,
    )
    .map((session) => ({
      id: session.id.slice(0, 8),
      project: session.project,
      model: session.model || 'unbekannt',
      status: session.status,
      activeMinutes: Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / MINUTE_MS)),
      turnMinutes:
        session.status === 'working' && session.turnStartedAt
          ? Math.max(0, Math.floor((now - Date.parse(session.turnStartedAt)) / MINUTE_MS))
          : 0,
      lastTurnMinutes:
        session.lastTurnMs == null ? null : Math.floor(session.lastTurnMs / MINUTE_MS),
      toolCount: session.toolCount,
      latestUsage: session.latestUsage ?? null,
      rateLimits: session.rateLimits ?? null,
      recommendations: sessionRecommendations(session, now),
    }));
  return { activeChats: chats.length, monitoredLocally: true, apiCallsForMonitoring: 0, chats };
}

export type ChatOverview = ReturnType<typeof buildChatOverview> & { note?: string };

export async function readChatOverview(dataDir: string | undefined): Promise<ChatOverview> {
  if (!dataDir) {
    return {
      activeChats: 0,
      monitoredLocally: false,
      apiCallsForMonitoring: 0,
      chats: [],
      note: 'Plugin-local storage is not available in this host.',
    };
  }
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(dataDir, 'jev-chat-monitor-state.json'), 'utf8'),
    );
    return buildChatOverview(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { activeChats: 0, monitoredLocally: true, apiCallsForMonitoring: 0, chats: [] };
    }
    throw error;
  }
}

export function formatChatOverview(view: ChatOverview) {
  const header = view.monitoredLocally
    ? `Jev überwacht ${view.activeChats} offene Codex-Chats lokal. Die Überwachung hat 0 API-Aufrufe verwendet.`
    : 'Die lokale Chat-Überwachung ist in diesem Codex-Host nicht verfügbar.';
  const rows = view.chats.map((chat) => {
    const usage = chat.latestUsage
      ? `letzte Anfrage ${chat.latestUsage.totalTokens.toLocaleString('de-DE')} Token${chat.latestUsage.contextWindow ? ` / ${chat.latestUsage.contextWindow.toLocaleString('de-DE')} Kontextfenster` : ''}`
      : 'Tokenkontext nicht verfügbar';
    const limits =
      chat.rateLimits?.primaryUsedPercent != null
        ? `; Codex-Hauptlimit ${Math.round(chat.rateLimits.primaryUsedPercent)}%`
        : '';
    const turn =
      chat.status === 'working'
        ? `aktueller Durchlauf ${chat.turnMinutes} Min.`
        : chat.lastTurnMinutes == null
          ? 'noch kein abgeschlossener Durchlauf'
          : `letzter Durchlauf ${chat.lastTurnMinutes} Min.`;
    const hints = chat.recommendations.map((hint) => `Hinweis: ${hint}`).join('\n  ');
    return `• ${chat.project} (${chat.id}) — ${chat.model}; ${chat.status}; offen ${chat.activeMinutes} Min.; ${turn}; ${chat.toolCount} Tool-Aufrufe; ${usage}${limits}${hints ? `\n  ${hints}` : ''}`;
  });
  return {
    content: [
      { type: 'text' as const, text: [header, ...rows, view.note].filter(Boolean).join('\n') },
    ],
    structuredContent: view,
  };
}
