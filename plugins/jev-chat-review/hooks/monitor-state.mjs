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

function promptComplexity(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const signals = [
    text.length > 700,
    /\b(refactor|architecture|migrate|debug|investigate|implement|multiple|several|across|security|performance)\b/i.test(text),
    /\b(test|tests|build|deploy|database|api|integration|repository|codebase)\b/i.test(text),
    (text.match(/\n/g) ?? []).length >= 4,
  ].filter(Boolean).length;
  return signals >= 2 ? 'complex' : text.length > 0 && text.length < 180 && signals === 0 ? 'simple' : 'unknown';
}

function recommendations(session, now = Date.now()) {
  const result = [];
  if (session.turnStartedAt && ['working','waiting'].includes(session.status) && now - Date.parse(session.turnStartedAt) >= LONG_TURN_MS) {
    result.push({ kind: 'long-running', text: 'Dieser Durchlauf läuft seit über 10 Minuten. Prüfe, ob der Chat noch Fortschritt macht oder einen klaren Zwischenauftrag braucht.' });
  }
  const recent = session.actions.slice(-6);
  if (recent.length >= 3 && recent.slice(-3).every((a) => a.signature === recent.at(-1).signature)) {
    result.push({ kind: 'possible-loop', text: 'Die letzten drei Tool-Aufrufe wiederholen dieselbe Aktion. Prüfe Ergebnis und ändere den Ansatz, bevor der Chat weiterläuft.' });
  }
  if (session.loopCount >= 2) {
    result.push({ kind: 'stronger-model', text: 'Mehrere wiederholte Aktionen erkannt. Ein stärkeres Modell könnte helfen; prüfe zuerst, ob der Auftrag in kleinere Schritte zerlegt werden sollte.' });
  } else if (session.taskComplexity === 'simple' && session.toolCount <= 1 && session.status !== 'working') {
    result.push({ kind: 'smaller-model', text: 'Der Auftrag wirkt einfach und brauchte kaum Werkzeuge. Bei ähnlichen Aufgaben könnte ein kleineres, schnelleres Modell reichen.' });
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
      toolCount: session.toolCount,
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
      session = { id, project: basename(String(event.cwd ?? '').replace(/[\\/]+$/, '')) || 'Codex', model: '', startedAt: stamp, updatedAt: stamp, status: 'idle', turnStartedAt: null, taskComplexity: 'unknown', toolCount: 0, loopCount: 0, actions: [] };
      state.sessions.push(session);
    }
    session.updatedAt = stamp;
    if (typeof event.model === 'string') session.model = event.model.slice(0, 100);
    if (eventName === 'sessionstart') session.status = 'idle';
    if (eventName === 'userpromptsubmit') {
      session.status = 'working';
      session.turnStartedAt = stamp;
      session.taskComplexity = promptComplexity(event.prompt);
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
    if (eventName === 'stop') session.status = 'waiting';
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
