import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const plugin = join(root, 'plugins', 'jev-chat-review');

test('Codex plugin automatically reviews completed runs and retains an optional MCP review tool', async () => {
  const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const skill = await readFile(join(plugin, 'skills', 'review-current-chat', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'jev-chat-review');
  assert.match(manifest.interface.longDescription, /After each completed Codex run/);
  assert.equal(mcp.mcpServers['mindrails-supervisor'].args[0], 'server.mjs');
  assert.deepEqual(mcp.mcpServers['mindrails-supervisor'].env_vars, ['AI_GATEWAY_API_KEY']);
  assert.match(skill, /Do not ask the user to paste the transcript/);
  assert.match(skill, /automatically through the plugin's Stop hook/);
  assert.equal(hooks.hooks.Stop[0].hooks[0].type, 'command');
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /review-stop\.mjs/);

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

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(plugin, 'server.mjs'), 'mcp'],
    env: { MINDRAILS_PROVIDER: 'mock' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'jev-chat-review-plugin-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('triage_agent_run'));
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
});
