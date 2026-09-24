import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { recordMonitorEvent } from '../plugins/jev-chat-review/hooks/monitor-state.mjs';

const root = process.cwd();
const plugin = join(root, 'plugins', 'jev-chat-review');

test('Codex plugin automatically reviews completed runs and retains an optional MCP review tool', async () => {
  const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const skill = await readFile(join(plugin, 'skills', 'review-current-chat', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'jev-chat-review');
  assert.match(manifest.interface.longDescription, /monitored locally/);
  assert.equal(mcp.mcpServers['mindrails-supervisor'].args[0], 'server.mjs');
  assert.deepEqual(mcp.mcpServers['mindrails-supervisor'].env_vars, ['AI_GATEWAY_API_KEY']);
  assert.match(skill, /Do not ask the user to paste the transcript/);
  assert.match(skill, /automatically through the plugin's Stop hook/);
  assert.ok(['SessionStart','UserPromptSubmit','PostToolUse','SessionEnd'].every(name => hooks.hooks[name]?.[0]?.hooks?.[0]?.async === true));
  const monitorStop = hooks.hooks.Stop[0].hooks.find(hook => hook.command.includes('monitor-event.mjs'));
  assert.equal(monitorStop.async, undefined);
  assert.match(hooks.hooks.Stop[0].hooks.find(hook => hook.command.includes('review-stop.mjs')).command, /review-stop\.mjs/);

  const hookScript = join(plugin, 'hooks', 'review-stop.mjs');
  const hookInput = JSON.stringify({ transcript_path: 'unused-transcript.jsonl' });
  const missingKey = spawnSync(process.execPath, [hookScript], {
    input: hookInput,
    encoding: 'utf8',
    env: { ...process.env, AI_GATEWAY_API_KEY: '', MINDRAILS_JEV_AUTO_REVIEW: '1' },
  });
  assert.equal(missingKey.status, 0);
  assert.match(JSON.parse(missingKey.stdout).systemMessage, /AI_GATEWAY_API_KEY/);
  const disabled = spawnSync(process.execPath, [hookScript], {
    input: hookInput,
    encoding: 'utf8',
    env: { ...process.env, AI_GATEWAY_API_KEY: '', MINDRAILS_JEV_AUTO_REVIEW: '0' },
  });
  assert.equal(disabled.status, 0);
  assert.equal(disabled.stdout, '');

  const monitorDir = await mkdtemp(join(tmpdir(),'jev-plugin-monitor-'));
  try {
    const now=Date.now();
    await recordMonitorEvent(monitorDir,{hook_event_name:'UserPromptSubmit',session_id:'visible-session',cwd:'C:\\work\\api',model:'fast',prompt:'Fix a typo'},now);
    await recordMonitorEvent(monitorDir,{hook_event_name:'Stop',session_id:'visible-session'},now+1000);
  } finally { /* keep the fixture until the MCP child has read it */ }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(plugin, 'server.mjs'), 'mcp'],
    env: { MINDRAILS_PROVIDER: 'mock', PLUGIN_DATA: monitorDir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'jev-chat-review-plugin-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('open_codex_chats'));
    assert.ok(tools.includes('triage_agent_run'));
    const overview = await client.callTool({ name:'open_codex_chats', arguments:{} });
    assert.equal(overview.structuredContent.apiCallsForMonitoring, 0);
    assert.equal(overview.structuredContent.chats[0].project,'api');
    assert.ok(overview.structuredContent.chats[0].recommendations.some(item => item.includes('kleineres')));
    const notice = spawnSync(process.execPath,[join(plugin,'hooks','monitor-event.mjs')],{input:JSON.stringify({hook_event_name:'Stop',session_id:'visible-session'}),encoding:'utf8',env:{...process.env,PLUGIN_DATA:monitorDir}});
    assert.equal(notice.status,0);
    assert.match(JSON.parse(notice.stdout).systemMessage,/Jev Chat-Monitor.*kleineres/);
    const result = await client.callTool({
      name: 'triage_agent_run',
      arguments: {
        task: 'Review a prepared result',
        instructions: 'Use the supplied material.',
        turns: [{ role: 'user', content: 'Prepare the result.' }],
        toolCalls: [],
        finalMessage: '[mock:complete] Result ready.',
      },
    });
    assert.equal(result.structuredContent.recommendation, 'AUTO_CLOSE');
  } finally {
    await client.close();
  }

  const noKeyTransport = new StdioClientTransport({command:process.execPath,args:[join(plugin,'server.mjs'),'mcp'],env:{MINDRAILS_PROVIDER:'jev',MINDRAILS_JEV_ROUTE:'vercel-ai-gateway',PLUGIN_DATA:monitorDir},stderr:'pipe'});
  const noKeyClient = new Client({name:'jev-monitor-without-key',version:'0.1.0'});
  try {
    await noKeyClient.connect(noKeyTransport);
    const overview=await noKeyClient.callTool({name:'open_codex_chats',arguments:{}});
    assert.equal(overview.structuredContent.apiCallsForMonitoring,0);
    assert.equal(overview.structuredContent.monitoredLocally,true);
  } finally { await noKeyClient.close(); await rm(monitorDir,{recursive:true,force:true}); }
});
