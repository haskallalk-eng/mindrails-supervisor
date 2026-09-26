import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const FILE = 'jev-chat-monitor-state.json';
const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const MAX_SESSIONS = 100;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const LONG_TURN_MS = 10 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const nowIso = () => new Date().toISOString();

async function withLock(dataDir, operation) {
  if (!dataDir) throw new Error('PLUGIN_DATA_MISSING');
  await mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'jev-chat-monitor.lock');
  let lock;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!lock && Date.now() < deadline) {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) await unlink(lockPath); }
      catch (statError) { if (statError?.code !== 'ENOENT') throw statError; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lock) throw new Error('MONITOR_STATE_BUSY');
  try {
    const path = join(dataDir, FILE);
    let state;
    try {
      state = JSON.parse(await readFile(path, 'utf8'));
      if (state?.version !== 1 || !Array.isArray(state.sessions)) throw new Error('invalid');
    } catch (error) {
      if (error?.code === 'ENOENT') state = { version: 1, sessions: [] };
      else throw new Error('MONITOR_STATE_INVALID');
    }
    const result = await operation(state);
    state.sessions = state.sessions.filter((s) => Date.now() - Date.parse(s.updatedAt) <= RETAIN_MS).slice(-MAX_SESSIONS);
    const temp = join(dataDir, `jev-chat-monitor-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
    return result;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function recommendations(session, now = Date.now()) {
  const result = [];
  const liveTurnMs = session.turnStartedAt ? now - Date.parse(session.turnStartedAt) : 0;
  if (session.status === 'working' && liveTurnMs >= LONG_TURN_MS) {
    result.push({ kind: 'long-running', text: 'Dieser Durchlauf läuft seit über 10 Minuten. Prüfe den letzten sichtbaren Fortschritt und gib bei Bedarf einen klaren nächsten Schritt.' });
  } else if (session.status === 'waiting' && session.lastTurnMs >= LONG_TURN_MS) {
    result.push({ kind: 'long-turn', text: `Der letzte Durchlauf dauerte ${Math.floor(session.lastTurnMs / 60_000)} Minuten. Prüfe, ob du den Auftrag künftig in klare Zwischenziele teilen möchtest.` });
  }
  const recent = session.actions.slice(-6);
  if (recent.length >= 3 && recent.slice(-3).every((a) => a.signature === recent.at(-1).signature)) {
    result.push({ kind: 'possible-loop', text: 'Die letzten drei Tool-Aufrufe wiederholen dieselbe Aktion. Prüfe Ergebnis und ändere den Ansatz, bevor der Chat weiterläuft.' });
  }
  if (session.loopCount >= 2) {
    result.push({ kind: 'repeated-stagnation', text: 'Dieselbe Tool-Aktion mit demselben Ergebnis wiederholte sich mehrfach. Ändere zuerst den Ansatz; Wiederholung allein belegt nicht, dass ein anderes Modell hilft.' });
  }
  const usage=session.latestUsage;
  if(usage?.contextWindow && usage.totalTokens/usage.contextWindow>=0.85) {
    const percent=Math.round(usage.totalTokens/usage.contextWindow*100);
    result.push({kind:'context-pressure',text:`Der letzte Codex-Aufruf nutzte etwa ${percent}% des gemeldeten Kontextfensters. Erwäge für die nächste größere Aufgabe einen neuen Chat oder eine kurze Übergabe.`});
  }
  const primary=session.rateLimits?.primaryUsedPercent;
  const secondary=session.rateLimits?.secondaryUsedPercent;
  if((primary!=null&&primary>=90)||(secondary!=null&&secondary>=90)) {
    result.push({kind:'usage-limit-pressure',text:`Codex meldet hohe Kontingentnutzung${primary!=null&&primary>=90?` im Kurzzeitfenster (${Math.round(primary)}%)`:''}${secondary!=null&&secondary>=90?` im Wochenfenster (${Math.round(secondary)}%)`:''}.`});
  }
  return result;
}

export function buildMonitorView(state, now = Date.now()) {
  const active = state.sessions
    .filter((session) => session.status !== 'ended')
    .map((session) => ({
      id: session.id.slice(0, 8),
      project: session.project,
      model: session.model || 'unbekannt',
      status: session.status,
      activeMinutes: Math.max(0, Math.floor((now - Date.parse(session.startedAt)) / 60_000)),
      turnMinutes: session.turnStartedAt ? Math.max(0, Math.floor((now - Date.parse(session.turnStartedAt)) / 60_000)) : 0,
      lastTurnMinutes: session.lastTurnMs == null ? null : Math.floor(session.lastTurnMs / 60_000),
      toolCount: session.toolCount,
      latestUsage: session.latestUsage ?? null,
      rateLimits: session.rateLimits ?? null,
      recommendations: recommendations(session, now),
    }));
  return { activeChats: active.length, monitoredLocally: true, apiCallsForMonitoring: 0, chats: active };
}

export async function recordMonitorEvent(dataDir, event = {}, now = Date.now()) {
  const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
  if (!sessionId) return { skipped: true };
  const eventName = String(event.hook_event_name ?? event.event_name ?? '').toLowerCase();
  return withLock(dataDir, async (state) => {
    const id = hash(sessionId);
    let session = state.sessions.find((candidate) => candidate.id === id);
    const stamp = new Date(now).toISOString();
    if (!session) {
      session = { id, project: basename(String(event.cwd ?? '').replace(/[\\/]+$/, '')) || 'Codex', model: '', startedAt: stamp, updatedAt: stamp, status: 'idle', turnStartedAt: null, lastTurnMs: null, toolCount: 0, loopCount: 0, actions: [] };
      state.sessions.push(session);
    }
    session.updatedAt = stamp;
    if (typeof event.model === 'string') session.model = event.model.slice(0, 100);
    if (eventName === 'sessionstart') session.status = 'idle';
    if (eventName === 'userpromptsubmit') {
      session.status = 'working';
      session.turnStartedAt = stamp;
      session.lastTurnMs = null;
      session.toolCount = 0;
      session.loopCount = 0;
      session.actions = [];
    }
    if (eventName === 'posttooluse') {
      session.status = 'working';
      session.toolCount++;
      const tool = String(event.tool_name ?? 'tool').slice(0, 100);
      const input = typeof event.tool_input === 'string' ? event.tool_input : JSON.stringify(event.tool_input ?? '');
      const output = typeof event.tool_response === 'string' ? event.tool_response : JSON.stringify(event.tool_response ?? '');
      session.actions.push({ signature: hash(`${tool}\0${input}\0${output}`) });
      session.actions = session.actions.slice(-10);
      if (session.actions.length >= 3 && session.actions.slice(-3).every((action) => action.signature === session.actions.at(-1).signature)) session.loopCount++;
    }
    if (eventName === 'stop') {
      if (session.turnStartedAt) session.lastTurnMs = Math.max(0, now - Date.parse(session.turnStartedAt));
      session.turnStartedAt = null;
      session.status = 'waiting';
    }
    if (eventName === 'sessionend') { session.status = 'ended'; session.turnStartedAt = null; }
    return { skipped: false, status: session.status, recommendations: recommendations(session, now).map((item) => item.text) };
  });
}

export async function readMonitorView(dataDir, now = Date.now()) {
  if (!dataDir) return { activeChats: 0, monitoredLocally: false, apiCallsForMonitoring: 0, chats: [], note: 'PLUGIN_DATA_MISSING' };
  try { return buildMonitorView(JSON.parse(await readFile(join(dataDir, FILE), 'utf8')), now); }
  catch (error) {
    if (error?.code === 'ENOENT') return buildMonitorView({ sessions: [] }, now);
    throw new Error('MONITOR_STATE_INVALID');
  }
}

export async function readMonitorSession(dataDir, sessionId) {
  if (!dataDir || typeof sessionId !== 'string' || !sessionId) return null;
  try {
    const state = JSON.parse(await readFile(join(dataDir, FILE), 'utf8'));
    const session = state?.sessions?.find((candidate) => candidate.id === hash(sessionId));
    if (!session) return null;
    return { currentModel: typeof session.model === 'string' && session.model !== 'unbekannt' ? session.model : null, toolCount: session.toolCount ?? 0, repeatedActions: session.loopCount ?? 0, latestUsage:session.latestUsage ?? null, rateLimits:session.rateLimits ?? null };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('MONITOR_STATE_INVALID');
  }
}

export async function recordMonitorUsage(dataDir, sessionId, usage, rateLimits) {
  if (!dataDir || typeof sessionId !== 'string' || !sessionId) return { skipped:true };
  return withLock(dataDir, async (state) => {
    const session = state.sessions.find((candidate) => candidate.id === hash(sessionId));
    if (!session) return { skipped:true };
    if (usage) session.latestUsage = usage;
    if (rateLimits) session.rateLimits = rateLimits;
    session.updatedAt = nowIso();
    return { skipped:false, recommendations:recommendations(session).map((item)=>item.text) };
  });
}
