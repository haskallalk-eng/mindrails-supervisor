import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const REVIEW_CACHE_SIZE = 256;

const emptyState = (date) => ({ date, calls: 0, inputBytes: 0, inputTokens: 0, outputTokens: 0, reviews: {} });
const today = (now = new Date()) => now.toISOString().slice(0, 10);
const sessionKey = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);

async function withStateLock(dataDir, operation) {
  await mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'jev-review.lock');
  let lock;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!lock && Date.now() < deadline) {
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
      } catch (statError) { if (statError?.code !== 'ENOENT') throw statError; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!lock) throw new Error('REVIEW_STATE_BUSY');
  try {
    const statePath = join(dataDir, 'jev-review-state.json');
    let state;
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state?.date !== today()) state = emptyState(today());
      else if (!Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isSafeInteger(state.inputBytes) || state.inputBytes < 0 || !Number.isSafeInteger(state.inputTokens) || state.inputTokens < 0 || !Number.isSafeInteger(state.outputTokens) || state.outputTokens < 0 || !state.reviews || typeof state.reviews !== 'object' || Array.isArray(state.reviews)) throw new Error('REVIEW_STATE_INVALID');
    } catch (error) {
      if (error?.code === 'ENOENT') state = emptyState(today());
      else throw new Error('REVIEW_STATE_INVALID');
    }
    const result = await operation(state);
    const tempPath = join(dataDir, `jev-review-state-${randomUUID()}.tmp`);
    await writeFile(tempPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, statePath);
    return result;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

export async function reserveReview({ dataDir, sessionId, transcriptHash, inputBytes, maxCalls, maxInputBytes }) {
  if (!dataDir || !sessionId || !transcriptHash) throw new Error('REVIEW_STATE_CONFIG_MISSING');
  return withStateLock(dataDir, async (state) => {
    const key = sessionKey(sessionId);
    if (state.reviews[key] === transcriptHash) return { status: 'duplicate', ...state, maxCalls, maxInputBytes };
    if (state.calls >= maxCalls || state.inputBytes + inputBytes > maxInputBytes) return { status: 'budget', ...state, maxCalls, maxInputBytes };
    state.calls++;
    state.inputBytes += inputBytes;
    state.reviews[key] = transcriptHash;
    const keys = Object.keys(state.reviews);
    for (const staleKey of keys.slice(0, Math.max(0, keys.length - REVIEW_CACHE_SIZE))) delete state.reviews[staleKey];
    return { status: 'reserved', ...state, maxCalls, maxInputBytes };
  });
}

export async function recordUsage(dataDir, { inputTokens = 0, outputTokens = 0 } = {}) {
  return withStateLock(dataDir, async (state) => {
    state.inputTokens += Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : 0;
    state.outputTokens += Number.isSafeInteger(outputTokens) && outputTokens > 0 ? outputTokens : 0;
    return { ...state };
  });
}

export function parsePositiveLimit(raw, fallback, max) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error('REVIEW_BUDGET_CONFIG_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('REVIEW_BUDGET_CONFIG_INVALID');
  return value;
}
