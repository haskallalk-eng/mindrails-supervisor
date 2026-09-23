#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { completionSchema, stuckSchema, Supervisor, detectStuck, SafeError } from './core.js';
import { MockProvider, JevProvider } from './providers.js';

function createSupervisor() {
  const mode = process.env.MINDRAILS_PROVIDER ?? 'mock';
  if (!['mock','jev'].includes(mode)) throw new SafeError('INVALID_PROVIDER');
  const positive = (name:string, fallback:number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new SafeError('INVALID_CONFIGURATION');
    return value;
  };
  return new Supervisor(mode === 'jev' ? new JevProvider(process.env.TYPESAFE_API_KEY ?? '') : new MockProvider(), {
    maxCalls:positive('MINDRAILS_MAX_CALLS',100), maxInputBytes:positive('MINDRAILS_MAX_INPUT_BYTES',320000), timeoutMs:positive('MINDRAILS_TIMEOUT_MS',5000), threshold:0.9,
  });
}
async function main() {
  const [command, file] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('Mindrails Supervisor v0.1.0\nUsage: mindrails-supervisor demo | check <file.json> | stuck <file.json> | mcp\nDefault provider: mock (synthetic markers; no semantic judgment). Jev: set MINDRAILS_PROVIDER=jev and TYPESAFE_API_KEY.'); return;
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
    const supervisor = createSupervisor();
    const server = new McpServer({name:'mindrails-supervisor',version:'0.1.0'});
    const format = (v:object) => ({content:[{type:'text' as const,text:JSON.stringify(v)}],structuredContent:v as Record<string,unknown>});
    server.registerTool('check_completion', {description:'Advisory completion gate. Default mock uses synthetic markers. Evidence and trustedChecks are host supplied, not independently verified. Jev mode sends inputs to TypeSafe and may cost money.', inputSchema:completionSchema}, async input => {
      try { return format(await supervisor.check(input)); } catch { return {isError:true,content:[{type:'text' as const,text:'INVALID_INPUT'}]}; }
    });
    server.registerTool('detect_stuck', {description:'Detect three identical trailing steps without caller-reported progress. Does not evaluate semantic progress.',inputSchema:stuckSchema}, async input => format(detectStuck(input)));
    await server.connect(new StdioServerTransport()); return;
  }
  if ((command === 'check' || command === 'stuck') && file) {
    if ((await stat(file)).size > 260000) throw new SafeError('INPUT_TOO_LARGE');
    const raw = JSON.parse(await readFile(file,'utf8'));
    console.log(JSON.stringify(command === 'check' ? await createSupervisor().check(raw) : detectStuck(raw),null,2)); return;
  }
  throw new SafeError('INVALID_COMMAND');
}
main().catch(e => { console.error(e instanceof SafeError ? e.code : 'INVALID_INPUT_OR_STARTUP_FAILURE'); process.exitCode=1; });
