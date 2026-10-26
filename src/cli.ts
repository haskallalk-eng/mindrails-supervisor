#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { completionSchema, stuckSchema, Supervisor, detectStuck, SafeError } from './core.js';
import { MockProvider } from './providers.js';
import { createSupervisor, createTriage } from './runtime-config.js';
import { readChatOverview, formatChatOverview } from './chat-overview.js';
import { traceTriageSchema } from './trace.js';

// Kept aligned with package.json by the CLI and MCP transport tests.
const VERSION = '0.8.0';

async function main() {
  const [command, file] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(
      `MindRails Supervisor v${VERSION}\nUsage: mindrails-supervisor demo | check <file.json> | triage <file.json> | stuck <file.json> | mcp\nCompletion uses artifact evidence by default. Set evidenceMode to fact-check to require source evidence. The demo is always synthetic. check, triage and mcp require explicit MINDRAILS_PROVIDER=mock or jev; stuck is deterministic. Jev defaults to the native TypeSafe route and TYPESAFE_API_KEY. The optional Vercel route uses MINDRAILS_JEV_ROUTE=vercel-ai-gateway and AI_GATEWAY_API_KEY. Inference may cost money.`,
    );
    return;
  }
  if (command === 'demo') {
    const supervisor = new Supervisor(new MockProvider());
    const requirements = ['readme', 'tests', 'build', 'license', 'security'].map((id) => ({
      id,
      description: `Include ${id}`,
    }));
    console.log('SYNTHETIC MOCK DEMO — no API call, no semantic evaluation');
    for (const n of [3, 5]) {
      const result = await supervisor.check({
        task: 'Prepare a release',
        requirements,
        currentResult: requirements
          .slice(0, n)
          .map((r) => `[done:${r.id}]`)
          .join(' '),
        evidence: 'Synthetic fixture evidence',
      });
      console.log(
        `${n}/5 markers → ${result.decision.toUpperCase()} ${result.requirementIds.join(', ')}`,
      );
    }
    const step = {
      action: 'search',
      input: 'release help',
      result: 'same result',
      progress: false,
    };
    console.log(
      `3 repeated steps → ${detectStuck({ steps: [step, step, step] }).decision.toUpperCase()}`,
    );
    console.log(
      `changed result → ${detectStuck({ steps: [step, step, { ...step, result: 'new result' }] }).decision.toUpperCase()}`,
    );
    return;
  }
  if (command === 'mcp') {
    const server = new McpServer({ name: 'mindrails-supervisor', version: VERSION });
    let supervisor: Supervisor | undefined;
    let triage: ReturnType<typeof createTriage> | undefined;
    const getSupervisor = () => (supervisor ??= createSupervisor());
    const getTriage = () => (triage ??= createTriage());
    const format = (v: object) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(v) }],
      structuredContent: v as Record<string, unknown>,
    });
    server.registerTool(
      'open_codex_chats',
      {
        description:
          'Show locally monitored Codex chats, current or last-turn duration, and exact repeated tool-call warnings. Monitoring stores no conversation text and makes no AI/API calls. It does not guess model fit from prompt length or tool count.',
        inputSchema: {},
      },
      async () => {
        try {
          return formatChatOverview(await readChatOverview(process.env.PLUGIN_DATA));
        } catch {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'MONITOR_STATE_UNAVAILABLE' }],
          };
        }
      },
    );
    server.registerTool(
      'check_completion',
      {
        description:
          'Advisory completion gate. Provider selection is explicit; mock uses synthetic markers. Artifact mode is the default; fact-check mode requires supplied evidence, which is not independently verified. Jev mode sends inputs to TypeSafe and may cost money.',
        inputSchema: completionSchema,
      },
      async (input) => {
        try {
          return format(await getSupervisor().check(input));
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: 'INVALID_INPUT' }] };
        }
      },
    );
    server.registerTool(
      'detect_stuck',
      {
        description:
          'Detect at least three trailing repetitions of a one-to-three-step cycle without caller-reported progress. Optional caller-declared grace allows at most two extra repetitions. Does not evaluate semantic progress.',
        inputSchema: stuckSchema,
      },
      async (input) => format(detectStuck(input)),
    );
    server.registerTool(
      'triage_agent_run',
      {
        description:
          'Classify an agent trace and return advisory completion, progress, blocker and next-step judgments. Recovery advice includes a static follow-up prompt only when judgments agree at configured thresholds. With currentModel telemetry, also evaluate model fit; prerequisite blockers suppress conflicting model changes. Never executes prompts or changes models. Jev mode sends the trace to the configured provider and may cost money. Action-permission claims are caller supplied and not verified.',
        inputSchema: traceTriageSchema,
      },
      async (input) => {
        try {
          return format(await getTriage().evaluate(input));
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: 'INVALID_INPUT' }] };
        }
      },
    );
    await server.connect(new StdioServerTransport());
    return;
  }
  if ((command === 'check' || command === 'stuck' || command === 'triage') && file) {
    if ((await stat(file)).size > 260000) throw new SafeError('INPUT_TOO_LARGE');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    console.log(
      JSON.stringify(
        command === 'check'
          ? await createSupervisor().check(raw)
          : command === 'triage'
            ? await createTriage().evaluate(raw)
            : detectStuck(raw),
        null,
        2,
      ),
    );
    return;
  }
  throw new SafeError('INVALID_COMMAND');
}
main().catch((e) => {
  console.error(e instanceof SafeError ? e.code : 'INVALID_INPUT_OR_STARTUP_FAILURE');
  process.exitCode = 1;
});
