import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const plugin = join(root, 'plugins', 'jev-chat-review');

test('Codex review plugin exposes a one-call current-chat review over its bundled MCP server', async () => {
  const manifest = JSON.parse(await readFile(join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  const skill = await readFile(join(plugin, 'skills', 'review-current-chat', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'jev-chat-review');
  assert.equal(mcp.mcpServers['mindrails-supervisor'].args[0], 'server.mjs');
  assert.deepEqual(mcp.mcpServers['mindrails-supervisor'].env_vars, ['AI_GATEWAY_API_KEY']);
  assert.match(skill, /Do not ask the user to paste the transcript/);
  assert.match(skill, /Do not send conversation content to Jev automatically/);

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
