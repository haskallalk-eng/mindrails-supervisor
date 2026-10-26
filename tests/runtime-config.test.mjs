import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor, createTriage, readProviderConfig } from '../dist/runtime-config.js';

const completion = {
  task: 'Write release notes',
  currentResult: '[done:notes]',
  evidence: 'Synthetic fixture',
  requirements: [{ id: 'notes', description: 'Release notes' }],
};
const trace = {
  task: 'Write notes',
  instructions: 'Use the fixture',
  turns: [],
  toolCalls: [],
  finalMessage: '[mock:complete]',
};

test('completion and triage enforce the same provider and route settings', () => {
  for (const factory of [createSupervisor, createTriage]) {
    for (const [env, code] of [
      [{}, 'MINDRAILS_PROVIDER_REQUIRED'],
      [{ MINDRAILS_PROVIDER: 'other' }, 'INVALID_PROVIDER'],
      [{ MINDRAILS_PROVIDER: 'jev', MINDRAILS_JEV_ROUTE: 'other' }, 'INVALID_JEV_ROUTE'],
      [{ MINDRAILS_PROVIDER: 'jev' }, 'INVALID_API_KEY'],
      [
        {
          MINDRAILS_PROVIDER: 'jev',
          MINDRAILS_JEV_ROUTE: 'vercel-ai-gateway',
          TYPESAFE_API_KEY: 'unused-fixture',
        },
        'INVALID_API_KEY',
      ],
    ])
      assert.throws(
        () => factory(env),
        (error) => error.code === code,
      );
  }
});

test('provider routes select only their own credential', () => {
  const env = {
    MINDRAILS_PROVIDER: 'jev',
    TYPESAFE_API_KEY: 'typesafe-fixture',
    AI_GATEWAY_API_KEY: 'gateway-fixture',
  };
  assert.deepEqual(readProviderConfig(env), {
    mode: 'jev',
    route: 'typesafe',
    key: 'typesafe-fixture',
  });
  assert.deepEqual(readProviderConfig({ ...env, MINDRAILS_JEV_ROUTE: 'vercel-ai-gateway' }), {
    mode: 'jev',
    route: 'vercel-ai-gateway',
    key: 'gateway-fixture',
  });
});

test('mock completion and triage run without provider credentials', async () => {
  const env = { MINDRAILS_PROVIDER: 'mock', MINDRAILS_JEV_ROUTE: 'unused-in-mock' };
  assert.equal((await createSupervisor(env).check(completion)).decision, 'finish');
  assert.equal((await createTriage(env).evaluate(trace)).recommendation, 'AUTO_CLOSE');
});

test('completion limits reject invalid numbers before running', () => {
  for (const field of [
    'MINDRAILS_MAX_CALLS',
    'MINDRAILS_MAX_INPUT_BYTES',
    'MINDRAILS_TIMEOUT_MS',
  ]) {
    for (const value of ['', '0', '-1', '1.5', 'Infinity', 'NaN', '1000001']) {
      assert.throws(
        () => createSupervisor({ MINDRAILS_PROVIDER: 'mock', [field]: value }),
        (error) => error.code === 'INVALID_CONFIGURATION',
      );
    }
  }
});

test('completion call budget is carried into the configured supervisor', async () => {
  const supervisor = createSupervisor({ MINDRAILS_PROVIDER: 'mock', MINDRAILS_MAX_CALLS: '1' });
  assert.equal((await supervisor.check(completion)).decision, 'finish');
  const second = await supervisor.check(completion);
  assert.notEqual(second.decision, 'finish');
});
