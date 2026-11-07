// Scoped MCP exposes task control and bounded record previews without publishing transport types.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bangul } from './bangul';
import { identity } from './values';
import { jobInput, settingsInput } from './config';
import { reconciliationInput, deliveryResolution } from './cli-execute';
const page = {
  limit: z.int().min(1).max(100).default(20),
  offset: z.int().min(0).max(100000).default(0),
};
const TEXT_PREVIEW_CHARACTERS = 2048;

export function createMcpServer(engine: Bangul): McpServer {
  const server = new McpServer(
    { name: 'n2-bangul', version: '1.0.0' },
    { maxToolInputElements: 1024 },
  );
  registerRead(server, engine);
  registerRunRead(server, engine);
  registerJobs(server, engine);
  registerJobControl(server, engine);
  registerControl(server, engine);
  registerRecovery(server, engine);
  return server;
}
function registerRead(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_status',
    {
      description: 'Read the timer state, shared settings and execution counts.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => result(() => engine.status()),
  );
  server.registerTool(
    'bangul_list',
    {
      description: 'List scheduled text tasks with bounded pagination.',
      inputSchema: page,
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => result(() => engine.list(limit, offset)),
  );
  server.registerTool(
    'bangul_get',
    {
      description:
        'Read one task with bounded prompt previews. Full definitions are available through the library or CLI.',
      inputSchema: { id: identity },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      result(() => {
        const job = engine.get(id);
        if (!job) throw new Error('Job was not found');
        const { user_message, system_prompt, description, ...definition } = job.definition;
        return {
          ...job,
          definition: {
            ...definition,
            user_message: preview(user_message, TEXT_PREVIEW_CHARACTERS),
            system_prompt: preview(system_prompt ?? '', TEXT_PREVIEW_CHARACTERS),
            description: preview(description, 512),
          },
        };
      }),
  );
}
function registerRunRead(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_history',
    {
      description: 'List durable execution outcomes, optionally restricted to one job.',
      inputSchema: { ...page, jobId: identity.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset, jobId }) => result(() => engine.history(limit, offset, jobId)),
  );
  server.registerTool(
    'bangul_read',
    {
      description: 'Read one immutable result in character-indexed chunks with delivery receipts.',
      inputSchema: {
        id: identity,
        offset: z.int().min(0).max(131072).default(0),
        limit: z.int().min(1).max(4096).default(TEXT_PREVIEW_CHARACTERS),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, offset, limit }) =>
      result(() => {
        const run = engine.getRun(id);
        if (!run) throw new Error('Execution was not found');
        const { snapshot, content, reconciliation, ...metadata } = run;
        const text = Array.from(content ?? '');
        return {
          ...metadata,
          provider: snapshot.provider,
          jobName: snapshot.job.name,
          content: text.slice(offset, offset + limit).join(''),
          offset,
          totalCharacters: text.length,
          hasMore: offset + limit < text.length,
          reconciliation: preview(reconciliation ?? '', 1024),
          deliveries: engine
            .getDeliveries(id)
            .map((row) => ({ ...row, reconciliation: preview(row.reconciliation ?? '', 512) })),
        };
      }),
  );
}
function registerJobs(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_create',
    {
      description: 'Register an explicitly zoned text task using at, every or cron scheduling.',
      inputSchema: { job: jobInput, id: identity.optional() },
      annotations: { readOnlyHint: false },
    },
    async ({ job, id }) =>
      result(() => {
        const record = engine.create(job, id);
        return { id: record.id, revision: record.revision, nextRunAt: record.nextRunAt };
      }),
  );
  server.registerTool(
    'bangul_update',
    {
      description:
        'Replace a task definition at its expected revision while preserving historical executions.',
      inputSchema: { id: identity, job: jobInput, revision: z.int().min(1) },
      annotations: { readOnlyHint: false },
    },
    async ({ id, job, revision }) =>
      result(() => {
        const record = engine.update(id, job, revision);
        return { id, revision: record.revision, nextRunAt: record.nextRunAt };
      }),
  );
}
function registerJobControl(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_remove',
    {
      description: 'Soft-delete a task at its expected revision and retain execution history.',
      inputSchema: { id: identity, revision: z.int().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, revision }) =>
      result(() => {
        engine.remove(id, revision);
        return { removed: id };
      }),
  );
  server.registerTool(
    'bangul_enable',
    {
      description:
        'Enable or pause future automatic execution. Unresolved prior requests require reconciliation.',
      inputSchema: { id: identity, enabled: z.boolean() },
      annotations: { readOnlyHint: false },
    },
    async ({ id, enabled }) =>
      result(() => {
        const record = engine.setEnabled(id, enabled);
        return { id, enabled: record.enabled, nextRunAt: record.nextRunAt };
      }),
  );
  server.registerTool(
    'bangul_trigger',
    {
      description:
        'Durably submit one manual text request and return its run ID. Read history for the eventual result.',
      inputSchema: { id: identity, runId: identity.optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, runId }) => result(() => engine.submit(id, runId)),
  );
}
function registerControl(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_configure',
    {
      description: 'Replace bounded concurrency, timer, deadline and startup catch-up settings.',
      inputSchema: { settings: settingsInput },
      annotations: { readOnlyHint: false },
    },
    async ({ settings }) => result(() => engine.configure(settings)),
  );
  server.registerTool(
    'bangul_start',
    {
      description: 'Start background scheduling in the configured scope.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () =>
      result(() => {
        engine.start();
        return engine.status();
      }),
  );
  server.registerTool(
    'bangul_stop',
    {
      description:
        'Stop future timer dispatch and wait for an already-dispatched catch-up request. Manual execution remains available.',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    async () =>
      result(async () => {
        await engine.stop();
        return engine.status();
      }),
  );
}
function registerRecovery(server: McpServer, engine: Bangul): void {
  server.registerTool(
    'bangul_reconcile',
    {
      description:
        'Resolve an unknown provider outcome using an inspected result and evidence. The job stays paused.',
      inputSchema: { id: identity, resolution: reconciliationInput },
      annotations: { readOnlyHint: false },
    },
    async ({ id, resolution }) =>
      result(() => {
        const run = engine.reconcileRun(id, resolution.outcome, resolution.evidence);
        return { id, status: run.status };
      }),
  );
  server.registerTool(
    'bangul_resolve_delivery',
    {
      description:
        'Resolve an unknown or failed delivery using receiver inspection evidence. Retry prepares a separate delivery attempt.',
      inputSchema: { id: identity, resolution: deliveryResolution },
      annotations: { readOnlyHint: false },
    },
    async ({ id, resolution }) =>
      result(() => {
        engine.resolveDelivery(id, resolution.channel, resolution.action, resolution.evidence);
        return { resolved: id, channel: resolution.channel };
      }),
  );
  server.registerTool(
    'bangul_deliver',
    {
      description:
        'Send pending delivery channels for a completed result without calling the model again.',
      inputSchema: { id: identity },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id }) =>
      result(async () => {
        await engine.deliver(id);
        return engine.getDeliveries(id);
      }),
  );
}
function preview(value: string, maximum: number) {
  const characters = Array.from(value);
  return {
    text: characters.slice(0, maximum).join(''),
    truncated: characters.length > maximum,
    totalCharacters: characters.length,
  };
}
async function result(operation: () => unknown | Promise<unknown>) {
  try {
    const text = JSON.stringify((await operation()) ?? null);
    if (Buffer.byteLength(text) > 60000)
      throw new Error('Tool result exceeds 60 KiB; reduce pagination or use the library');
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: Array.from(message).slice(0, 1000).join('') }),
        },
      ],
    };
  }
}
