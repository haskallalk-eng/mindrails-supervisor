import { SafeError, Supervisor } from './core.js';
import { JevProvider, MockProvider } from './providers.js';
import { createTraceTriage } from './triage.js';

type ProviderMode = 'mock' | 'jev';
type JevRoute = 'typesafe' | 'vercel-ai-gateway';

export function readProviderConfig(env: NodeJS.ProcessEnv = process.env): {
  mode: ProviderMode;
  route: JevRoute;
  key: string | undefined;
} {
  const mode = env.MINDRAILS_PROVIDER;
  if (!mode) throw new SafeError('MINDRAILS_PROVIDER_REQUIRED');
  if (mode !== 'mock' && mode !== 'jev') throw new SafeError('INVALID_PROVIDER');

  const requestedRoute = env.MINDRAILS_JEV_ROUTE ?? 'typesafe';
  if (mode === 'jev' && requestedRoute !== 'typesafe' && requestedRoute !== 'vercel-ai-gateway') {
    throw new SafeError('INVALID_JEV_ROUTE');
  }
  // Mock mode has no provider connection and does not require a valid route or key.
  const route = requestedRoute === 'vercel-ai-gateway' ? requestedRoute : 'typesafe';
  const key = route === 'typesafe' ? env.TYPESAFE_API_KEY : env.AI_GATEWAY_API_KEY;
  return { mode, route, key };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new SafeError('INVALID_CONFIGURATION');
  }
  return value;
}

export function createSupervisor(env: NodeJS.ProcessEnv = process.env): Supervisor {
  const { mode, route, key } = readProviderConfig(env);
  const provider = mode === 'jev' ? new JevProvider(key ?? '', fetch, route) : new MockProvider();
  return new Supervisor(provider, {
    maxCalls: positiveInteger(env, 'MINDRAILS_MAX_CALLS', 100),
    maxInputBytes: positiveInteger(env, 'MINDRAILS_MAX_INPUT_BYTES', 320_000),
    timeoutMs: positiveInteger(env, 'MINDRAILS_TIMEOUT_MS', 5_000),
    threshold: 0.85,
  });
}

export function createTriage(env: NodeJS.ProcessEnv = process.env) {
  const { mode, route, key } = readProviderConfig(env);
  return createTraceTriage(mode, key, route);
}
