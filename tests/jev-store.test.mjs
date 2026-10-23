import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversationStore } from '../dist/jev-app/store.js';

const file = (dir, id) => join(dir, 'app', 'conversations', `${id}.json`);

test('conversation storage validates nested records and preserves corrupted originals', async (t) => {
  const cases = [
    ['malformed JSON', () => '{unfinished'],
    ['JSON null', () => 'null'],
    ['messages null', c => JSON.stringify({ ...c, messages: null })],
    ['message text object', c => JSON.stringify({ ...c, messages: [{ id: randomUUID(), at: 1, role: 'user', text: {} }] })],
    ['message invalid role', c => JSON.stringify({ ...c, messages: [{ id: randomUUID(), at: 1, role: 'owner', text: 'x' }] })],
    ['invalid activity', c => JSON.stringify({ ...c, messages: [{ id: randomUUID(), at: 1, role: 'assistant', text: 'x', activity: [null] }] })],
    ['agents null', c => JSON.stringify({ ...c, agents: null })],
    ['invalid session', c => JSON.stringify({ ...c, agents: { claude: { sessionId: null, seenUpTo: 0 } } })],
    ['negative history offset', c => JSON.stringify({ ...c, agents: { codex: { sessionId: 's', seenUpTo: -1 } } })],
    ['history offset beyond messages', c => JSON.stringify({ ...c, agents: { claude: { sessionId: 's', seenUpTo: 1 } } })],
    ['timestamp string', c => JSON.stringify({ ...c, updatedAt: 'today' })],
    ['access invalid', c => JSON.stringify({ ...c, access: 'all' })],
    ['origin invalid', c => JSON.stringify({ ...c, origin: { kind: 'other', id: 'x', title: 'x' } })],
    ['record identity mismatch', c => JSON.stringify({ ...c, id: randomUUID() })],
  ];
  for (const [label, corrupt] of cases) await t.test(label, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-corrupt-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new ConversationStore(dir), bad = store.create({ cwd: dir }), good = store.create({ cwd: dir, title: 'healthy' });
    const bytes = corrupt(bad); await writeFile(file(dir, bad.id), bytes);
    assert.equal(store.get(bad.id), null);
    assert.deepEqual(store.list().map(c => c.id), [good.id], 'one corrupt conversation does not break the healthy list');
    assert.equal(store.getProblems().length, 1);
    assert.equal(store.getProblems()[0].file, `${bad.id}.json`);
    assert.throws(() => store.save(bad), /CORRUPT_CONVERSATION_FILE/, 'a stale valid in-memory copy cannot destroy the corrupted original');
    assert.equal(await readFile(file(dir, bad.id), 'utf8'), bytes);
    assert.equal(store.get(good.id).title, 'healthy');
  });
});

test('valid conversations round-trip metadata; invalid writes never replace valid data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConversationStore(dir), c = store.create({ cwd: dir });
  store.add(c, { role: 'user', text: 'Keep this history' });
  c.agents.claude = { sessionId: 'native-session', seenUpTo: 1, futureSetting: true };
  c.metadata = { futureVersion: 2 }; c.messages[0].extra = 'preserve'; store.save(c);
  const restored = store.get(c.id);
  assert.deepEqual(restored.metadata, c.metadata);
  assert.equal(restored.messages[0].extra, 'preserve');
  assert.equal(restored.agents.claude.futureSetting, true);
  const before = await readFile(file(dir, c.id), 'utf8');
  assert.throws(() => store.save({ ...restored, messages: null }), /INVALID_CONVERSATION_RECORD/);
  assert.equal(await readFile(file(dir, c.id), 'utf8'), before);
  await writeFile(join(dir, 'app', 'conversations', 'not-an-id.json'), '{}');
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.getProblems(), [{ file: 'not-an-id.json', reason: 'invalid-id' }]);
  assert.equal(store.get('../escape'), null);
});

test('app state remains available and reports damaged conversation files without exposing their contents', async (t) => {
  const { startApp } = await import('../dist/jev-app/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-state-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const token = 'a'.repeat(48);
  const app = await startApp({ stateDir: dir, port: 0, token, available: () => ({ claude: false, codex: false }), catalog: () => [] });
  t.after(() => app.close());
  const good = app.engine.store.create({ cwd: dir }), bad = app.engine.store.create({ cwd: dir });
  const raw = JSON.stringify({ ...bad, messages: null, privateDraft: 'must not be returned' });
  await writeFile(file(dir, bad.id), raw);
  const response = await fetch(`${app.url.split('/?')[0]}/api/state`, { headers: { 'x-jev-token': token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.conversations.map(c => c.id), [good.id]);
  assert.deepEqual(state.conversationProblems, [{ file: `${bad.id}.json`, reason: 'invalid-record' }]);
  assert.ok(!JSON.stringify(state).includes('must not be returned'));
  assert.equal(await readFile(file(dir, bad.id), 'utf8'), raw);
});

test('a UUID.json directory cannot break the conversation list or app state and is never replaced', async (t) => {
  const { startApp } = await import('../dist/jev-app/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-directory-record-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConversationStore(dir), good = store.create({ cwd: dir }), badId = randomUUID();
  const directory = file(dir, badId); await mkdir(directory);
  await writeFile(join(directory, 'keep.txt'), 'original directory contents');
  assert.throws(() => fs.readFileSync(directory, 'utf8'), { code: 'EISDIR' }, 'real filesystem reproduction of the review finding');
  assert.equal(store.get(badId), null);
  assert.deepEqual(store.list().map(c => c.id), [good.id]);
  assert.deepEqual(store.getProblems(), [{ file: `${badId}.json`, reason: 'not-regular-file' }]);
  assert.throws(() => store.save({ ...good, id: badId }), /CORRUPT_CONVERSATION_FILE/);
  assert.ok((await stat(directory)).isDirectory());
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'original directory contents');
  const token = 'c'.repeat(48);
  const app = await startApp({ stateDir: dir, port: 0, token, available: () => ({ claude: false, codex: false }), catalog: () => [] });
  t.after(() => app.close());
  const response = await fetch(`${app.url.split('/?')[0]}/api/state`, { headers: { 'x-jev-token': token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.conversations.map(c => c.id), [good.id]);
  assert.deepEqual(state.conversationProblems, [{ file: `${badId}.json`, reason: 'not-regular-file' }]);
});

test('a simulated EACCES read leaves good conversations available, warns, and refuses stale overwrite', async (t) => {
  const { startApp } = await import('../dist/jev-app/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'jev-unreadable-record-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConversationStore(dir), good = store.create({ cwd: dir }), bad = store.create({ cwd: dir });
  const blockedPath = file(dir, bad.id), before = await readFile(blockedPath, 'utf8');
  const originalRead = fs.readFileSync; let deniedReads = 0;
  // ACL behavior depends on the OS/test account. Inject only the read error at the filesystem boundary.
  const mock = t.mock.method(fs, 'readFileSync', function (path, ...args) {
    if (String(path) === blockedPath) { deniedReads++; throw Object.assign(new Error('synthetic permission denied'), { code: 'EACCES' }); }
    return originalRead.call(this, path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(store.get(bad.id), null);
  assert.deepEqual(store.list().map(c => c.id), [good.id]);
  assert.deepEqual(store.getProblems(), [{ file: `${bad.id}.json`, reason: 'unreadable' }]);
  assert.throws(() => store.save(bad), /CORRUPT_CONVERSATION_FILE/);
  const token = 'd'.repeat(48);
  const app = await startApp({ stateDir: dir, port: 0, token, available: () => ({ claude: false, codex: false }), catalog: () => [] });
  t.after(() => app.close());
  const response = await fetch(`${app.url.split('/?')[0]}/api/state`, { headers: { 'x-jev-token': token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.conversations.map(c => c.id), [good.id]);
  assert.deepEqual(state.conversationProblems, [{ file: `${bad.id}.json`, reason: 'unreadable' }]);
  assert.ok(deniedReads >= 4, 'get, list, save and API all exercised the injected read failure');
  mock.mock.restore(); syncBuiltinESMExports();
  assert.equal(await readFile(blockedPath, 'utf8'), before);
  assert.equal(store.get(bad.id).id, bad.id);
  assert.deepEqual(store.getProblems(), [], 'the warning clears when the file becomes readable again');
});
