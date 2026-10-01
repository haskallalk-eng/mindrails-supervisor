#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { completionSchema, stuckSchema, Supervisor, detectStuck, SafeError } from './core.js';
import { MockProvider, JevProvider } from './providers.js';
import { createTraceTriage } from './triage.js';
import { traceTriageSchema } from './trace.js';

function createSupervisor() {
  const mode = process.env.MINDRAILS_PROVIDER;
  if (!mode) throw new SafeError('MINDRAILS_PROVIDER_REQUIRED');
  if (!['mock','jev'].includes(mode)) throw new SafeError('INVALID_PROVIDER');
  const positive = (name:string, fallback:number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new SafeError('INVALID_CONFIGURATION');
    return value;
  };
  const route = process.env.MINDRAILS_JEV_ROUTE ?? 'typesafe';
  if (mode === 'jev' && !['typesafe','vercel-ai-gateway'].includes(route)) throw new SafeError('INVALID_JEV_ROUTE');
  const key = route === 'typesafe' ? process.env.TYPESAFE_API_KEY : process.env.AI_GATEWAY_API_KEY;
  return new Supervisor(mode === 'jev' ? new JevProvider(key ?? '',fetch,route as 'typesafe'|'vercel-ai-gateway') : new MockProvider(), {
    maxCalls:positive('MINDRAILS_MAX_CALLS',100), maxInputBytes:positive('MINDRAILS_MAX_INPUT_BYTES',320000), timeoutMs:positive('MINDRAILS_TIMEOUT_MS',5000), threshold:0.85,
  });
}
function createTriage() {
  const mode=process.env.MINDRAILS_PROVIDER;
  if (!mode) throw new SafeError('MINDRAILS_PROVIDER_REQUIRED');
  if (!['mock','jev'].includes(mode)) throw new SafeError('INVALID_PROVIDER');
  const route=process.env.MINDRAILS_JEV_ROUTE ?? 'typesafe';
  if (mode==='jev' && !['typesafe','vercel-ai-gateway'].includes(route)) throw new SafeError('INVALID_JEV_ROUTE');
  const key=route==='typesafe' ? process.env.TYPESAFE_API_KEY : process.env.AI_GATEWAY_API_KEY;
  return createTraceTriage(mode as 'mock'|'jev',key,route as 'typesafe'|'vercel-ai-gateway');
}
async function main() {
  const [command, file] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Mindrails Supervisor v0.2.0\nUsage: mindrails-supervisor demo | check <file.json> | triage <file.json> | stuck <file.json> | mcp\nCompletion uses artifact evidence by default. Set evidenceMode to fact-check to require source evidence. The demo is always synthetic. check, triage and mcp require explicit MINDRAILS_PROVIDER=mock or jev; stuck is deterministic. Jev defaults to the native TypeSafe route and TYPESAFE_API_KEY. The optional Vercel route uses MINDRAILS_JEV_ROUTE=vercel-ai-gateway and AI_GATEWAY_API_KEY. Inference may cost money.'); return;
  }
  if (command === 'demo') {
    const supervisor = new Supervisor(new MockProvider());
    const requirements = ['readme','tests','build','license','security'].map(id => ({id,description:`Include ${id}`}));
    console.log('SYNTHETIC MOCK DEMO — no API call, no semantic evaluation');
    for (const n of [3,5]) {
      const result = await supervisor.check({task:'Prepare a release', requirements, currentResult:requirements.slice(0,n).map(r => `[done:${r.id}]`).join(' '), evidence:'Synthetic fixture evidence'});
      console.log(`${n}/5 markers → ${result.decision.toUpperCase()} ${result.requirementIds.join(', ')}`);
    }
    const step = {action:'search',input:'release help',result:'same result',progress:false};
    console.log(`3 repeated steps → ${detectStuck({steps:[step,step,step]}).decision.toUpperCase()}`);
    console.log(`changed result → ${detectStuck({steps:[step,step,{...step,result:'new result'}]}).decision.toUpperCase()}`);
    return;
  }
  if (command === 'mcp') {
    const server = new McpServer({name:'mindrails-supervisor',version:'0.2.0'});
    let supervisor: Supervisor | undefined;
    let triage: ReturnType<typeof createTriage> | undefined;
    const getSupervisor = () => supervisor ??= createSupervisor();
    const getTriage = () => triage ??= createTriage();
    const format = (v:object) => ({content:[{type:'text' as const,text:JSON.stringify(v)}],structuredContent:v as Record<string,unknown>});
    const formatChatOverview = (view: {activeChats:number;monitoredLocally:boolean;apiCallsForMonitoring:number;chats:Array<{id:string;project:string;model:string;status:string;activeMinutes:number;turnMinutes:number;lastTurnMinutes:number|null;toolCount:number;latestUsage?:{totalTokens:number;contextWindow:number|null}|null;rateLimits?:{primaryUsedPercent:number|null;secondaryUsedPercent:number|null}|null;recommendations:string[]}>;note?:string}) => {
      const header = view.monitoredLocally ? `Jev überwacht ${view.activeChats} offene Codex-Chats lokal. Die Überwachung hat 0 API-Aufrufe verwendet.` : 'Die lokale Chat-Überwachung ist in diesem Codex-Host nicht verfügbar.';
      const rows = view.chats.map(chat => {
        const usage=chat.latestUsage ? `letzte Anfrage ${chat.latestUsage.totalTokens.toLocaleString('de-DE')} Token${chat.latestUsage.contextWindow ? ` / ${chat.latestUsage.contextWindow.toLocaleString('de-DE')} Kontextfenster` : ''}` : 'Tokenkontext nicht verfügbar';
        const limits=chat.rateLimits?.primaryUsedPercent!=null ? `; Codex-Hauptlimit ${Math.round(chat.rateLimits.primaryUsedPercent)}%` : '';
        return `• ${chat.project} (${chat.id}) — ${chat.model}; ${chat.status}; offen ${chat.activeMinutes} Min.; ${chat.status === 'working' ? `aktueller Durchlauf ${chat.turnMinutes} Min.` : chat.lastTurnMinutes == null ? 'noch kein abgeschlossener Durchlauf' : `letzter Durchlauf ${chat.lastTurnMinutes} Min.`}; ${chat.toolCount} Tool-Aufrufe; ${usage}${limits}${chat.recommendations.length ? `\n  ${chat.recommendations.map(hint => `Hinweis: ${hint}`).join('\n  ')}` : ''}`;
      }).join('\n');
      return {content:[{type:'text' as const,text:[header,rows,view.note ?? ''].filter(Boolean).join('\n')}],structuredContent:view as Record<string,unknown>};
    };
    server.registerTool('open_codex_chats', {description:'Show locally monitored Codex chats, current or last-turn duration, and exact repeated tool-call warnings. Monitoring stores no conversation text and makes no AI/API calls. It does not guess model fit from prompt length or tool count.', inputSchema:{}}, async () => {
      try {
        const dataDir = process.env.PLUGIN_DATA;
        if (!dataDir) return formatChatOverview({activeChats:0,monitoredLocally:false,apiCallsForMonitoring:0,chats:[],note:'Plugin-local storage is not available in this host.'});
        const state = JSON.parse(await readFile(join(dataDir,'jev-chat-monitor-state.json'),'utf8'));
        const sessions = Array.isArray(state.sessions) ? state.sessions : [];
        const now = Date.now();
        const chats = sessions.filter((s: any) => s.status !== 'ended' && now - Date.parse(s.updatedAt) < 24 * 60 * 60 * 1000).map((s: any) => {
          const actions = Array.isArray(s.actions) ? s.actions.slice(-6) : [];
          const hints: string[] = [];
          const started = Date.parse(s.turnStartedAt ?? '');
          if (s.status === 'working' && Number.isFinite(started) && now - started >= 10 * 60 * 1000) hints.push('Dieser Durchlauf läuft seit über 10 Minuten. Prüfe den letzten sichtbaren Fortschritt und gib bei Bedarf einen klaren nächsten Schritt.');
          else if (s.status === 'waiting' && s.lastTurnMs >= 10 * 60 * 1000) hints.push(`Der letzte Durchlauf dauerte ${Math.floor(s.lastTurnMs / 60000)} Minuten. Prüfe, ob du den Auftrag künftig in klare Zwischenziele teilen möchtest.`);
          if (actions.length >= 3 && actions.slice(-3).every((a: any) => a.signature === actions.at(-1)?.signature)) hints.push('Die letzten drei Tool-Aufrufe wiederholen dieselbe Aktion. Prüfe Ergebnis und ändere den Ansatz.');
          if ((s.loopCount ?? 0) >= 2) hints.push('Dieselbe Tool-Aktion mit demselben Ergebnis wiederholte sich mehrfach. Ändere zuerst den Ansatz; Wiederholung allein belegt nicht, dass ein anderes Modell hilft.');
          return {id:String(s.id).slice(0,8),project:s.project ?? 'Codex',model:s.model || 'unbekannt',status:s.status,activeMinutes:Math.max(0,Math.floor((now-Date.parse(s.startedAt))/60000)),turnMinutes:s.status === 'working' && Number.isFinite(started)?Math.max(0,Math.floor((now-started)/60000)):0,lastTurnMinutes:s.lastTurnMs == null ? null : Math.floor(s.lastTurnMs / 60000),toolCount:s.toolCount ?? 0,latestUsage:s.latestUsage ?? null,rateLimits:s.rateLimits ?? null,recommendations:hints};
        });
        return formatChatOverview({activeChats:chats.length,monitoredLocally:true,apiCallsForMonitoring:0,chats});
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return formatChatOverview({activeChats:0,monitoredLocally:true,apiCallsForMonitoring:0,chats:[]});
        return {isError:true,content:[{type:'text' as const,text:'MONITOR_STATE_UNAVAILABLE'}]};
      }
    });
    server.registerTool('check_completion', {description:'Advisory completion gate. Provider selection is explicit; mock uses synthetic markers. Artifact mode is the default; fact-check mode requires supplied evidence, which is not independently verified. Jev mode sends inputs to TypeSafe and may cost money.', inputSchema:completionSchema}, async input => {
      try { return format(await getSupervisor().check(input)); } catch { return {isError:true,content:[{type:'text' as const,text:'INVALID_INPUT'}]}; }
    });
    server.registerTool('detect_stuck', {description:'Detect at least three trailing repetitions of a one-to-three-step cycle without caller-reported progress. Optional caller-declared grace allows at most two extra repetitions. Does not evaluate semantic progress.',inputSchema:stuckSchema}, async input => format(detectStuck(input)));
    server.registerTool('triage_agent_run', {description:'Classify an agent trace and return advisory completion, progress, blocker and next-step judgments. Recovery advice includes a static follow-up prompt only when judgments agree at configured thresholds. With currentModel telemetry, also evaluate model fit; prerequisite blockers suppress conflicting model changes. Never executes prompts or changes models. Jev mode sends the trace to the configured provider and may cost money. Action-permission claims are caller supplied and not verified.',inputSchema:traceTriageSchema}, async input => {
      try { return format(await getTriage().evaluate(input)); } catch { return {isError:true,content:[{type:'text' as const,text:'INVALID_INPUT'}]}; }
    });
    await server.connect(new StdioServerTransport()); return;
  }
  if ((command === 'check' || command === 'stuck' || command === 'triage') && file) {
    if ((await stat(file)).size > 260000) throw new SafeError('INPUT_TOO_LARGE');
    const raw = JSON.parse(await readFile(file,'utf8'));
    console.log(JSON.stringify(command === 'check' ? await createSupervisor().check(raw) : command === 'triage' ? await createTriage().evaluate(raw) : detectStuck(raw),null,2)); return;
  }
  throw new SafeError('INVALID_COMMAND');
}
main().catch(e => { console.error(e instanceof SafeError ? e.code : 'INVALID_INPUT_OR_STARTUP_FAILURE'); process.exitCode=1; });
