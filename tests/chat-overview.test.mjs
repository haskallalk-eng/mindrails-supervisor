import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChatOverview, readChatOverview, formatChatOverview } from '../dist/chat-overview.js';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const session = {
  id: 'synthetic-session',
  project: 'demo',
  model: 'fixture-model',
  status: 'working',
  startedAt: new Date(now - 20 * 60000).toISOString(),
  updatedAt: new Date(now).toISOString(),
  turnStartedAt: new Date(now - 11 * 60000).toISOString(),
  lastTurnMs: null,
  toolCount: 3,
  actions: [{ signature: 'same' }, { signature: 'same' }, { signature: 'same' }],
  loopCount: 2,
};
const state = (...sessions) => ({ version: 1, sessions });

test('overview filters ended and stale sessions and retains working-turn warnings', () => {
  const result = buildChatOverview(
    state(
      session,
      { ...session, status: 'ended' },
      {
        ...session,
        updatedAt: new Date(now - 24 * 60 * 60000).toISOString(),
      },
    ),
    now,
  );
  assert.equal(result.activeChats, 1);
  assert.equal(result.apiCallsForMonitoring, 0);
  const chat = result.chats[0];
  assert.equal(chat.id, 'syntheti');
  assert.equal(chat.activeMinutes, 20);
  assert.equal(chat.turnMinutes, 11);
  assert.equal(chat.recommendations.length, 3);
  assert.match(formatChatOverview(result).content[0].text, /aktueller Durchlauf 11 Min/);
});

test('waiting sessions report the finished turn and preserve numeric usage', () => {
  const result = buildChatOverview(
    state({
      ...session,
      status: 'waiting',
      turnStartedAt: null,
      lastTurnMs: 12 * 60000,
      actions: [],
      loopCount: 0,
      latestUsage: { inputTokens: 12000, totalTokens: 12220, contextWindow: 200000 },
      rateLimits: { primaryUsedPercent: 31, secondaryUsedPercent: 18 },
    }),
    now,
  );
  assert.equal(result.chats[0].turnMinutes, 0);
  assert.equal(result.chats[0].lastTurnMinutes, 12);
  assert.equal(result.chats[0].latestUsage.inputTokens, 12000);
  assert.match(formatChatOverview(result).content[0].text, /12\.220 Token/);
  assert.match(result.chats[0].recommendations[0], /12 Minuten/);
});

test('unrelated stored fields are not returned as monitoring data', () => {
  const result = buildChatOverview(state({ ...session, transcript: 'private fixture text' }), now);
  assert.doesNotMatch(JSON.stringify(result), /private fixture text|transcript/);
});

test('malformed stored state is rejected instead of presenting a false healthy overview', () => {
  for (const raw of [
    null,
    [],
    {},
    { version: 2, sessions: [] },
    state(null),
    state({ ...session, updatedAt: 'invalid' }),
    state({ ...session, toolCount: '3' }),
    state({ ...session, actions: [{ signature: null }] }),
    state({ ...session, latestUsage: { totalTokens: 'bad', contextWindow: null } }),
  ]) {
    assert.throws(() => buildChatOverview(raw, now));
  }
});

test('missing storage, absent state and corrupt state remain distinct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-overview-'));
  try {
    assert.equal((await readChatOverview(undefined)).monitoredLocally, false);
    assert.deepEqual((await readChatOverview(dir)).chats, []);
    await writeFile(join(dir, 'jev-chat-monitor-state.json'), '{broken');
    await assert.rejects(readChatOverview(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
