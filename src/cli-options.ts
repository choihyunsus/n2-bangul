// Command options keep ownership explicit and host capability modules separate from task JSON.
import { parseArgs } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BangulOptions } from './types';
import { identity, utf8 } from './values';

export const COMMANDS = [
  'create',
  'update',
  'remove',
  'enable',
  'pause',
  'get',
  'list',
  'trigger',
  'history',
  'read',
  'configure',
  'status',
  'deliver',
  'reconcile',
  'resolve-delivery',
  'run',
  'mcp',
] as const;
export function argumentsForCli(args: string[]) {
  const parsed = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      db: { type: 'string' },
      project: { type: 'string' },
      agent: { type: 'string' },
      adapter: { type: 'string' },
      input: { type: 'string' },
      id: { type: 'string' },
      'run-id': { type: 'string' },
      revision: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
    },
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}`);
    seen.add(token.name);
  }
  validateOptions(parsed.values, parsed.positionals[0]);
  return parsed;
}
export type CliArguments = ReturnType<typeof argumentsForCli>;
function validateOptions(values: CliArguments['values'], command?: string): void {
  const allowed: Record<string, readonly string[]> = {
    input: ['create', 'update', 'configure', 'reconcile', 'resolve-delivery'],
    id: [
      'create',
      'update',
      'remove',
      'enable',
      'pause',
      'get',
      'trigger',
      'history',
      'read',
      'deliver',
      'reconcile',
      'resolve-delivery',
    ],
    'run-id': ['trigger'],
    revision: ['update', 'remove'],
    limit: ['list', 'history'],
    offset: ['list', 'history'],
  };
  for (const [name, commands] of Object.entries(allowed))
    if (values[name as keyof typeof values] !== undefined && !commands.includes(command ?? ''))
      throw new Error(`--${name} is not supported by this command`);
}
export async function engineOptions(values: CliArguments['values']): Promise<BangulOptions> {
  const options = {
    dbPath: utf8(8192).min(1).parse(values.db),
    project: identity.parse(values.project),
    agent: identity.parse(values.agent),
  };
  if (!values.adapter) return options;
  const filename = await realpath(path.resolve(utf8(8192).min(1).parse(values.adapter)));
  const info = await stat(filename);
  if (
    !info.isFile() ||
    info.size > 1048576 ||
    !['.js', '.mjs', '.cjs'].includes(path.extname(filename))
  )
    throw new Error('Adapter must be a local JavaScript file within 1 MiB');
  let adapter: Partial<BangulOptions>;
  try {
    const loaded = await import(pathToFileURL(filename).href);
    adapter = loaded.default ?? loaded;
    if (!adapter || typeof adapter !== 'object') throw new Error('Invalid host adapter');
  } catch {
    throw new Error('Host adapter could not be loaded');
  }
  return {
    ...options,
    provider: adapter.provider,
    providers: adapter.providers,
    policy: adapter.policy,
    broadcast: adapter.broadcast,
    webhooks: adapter.webhooks,
    settings: adapter.settings,
  };
}
export async function readInput(value: string | undefined, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (value !== undefined) return JSON.parse(utf8(524288).parse(value));
  if (process.stdin.isTTY) throw new Error('Supply task JSON through stdin or --input');
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => process.stdin.destroy(new Error('Task input was cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => process.stdin.destroy(new Error('Task input timed out')), 30000);
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 524288) throw new Error('Task input exceeds 512 KiB');
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}
export const HELP = `n2-bangul <${COMMANDS.join('|')}>
  --db <mimir.db> --project <project> --agent <agent> [--adapter <host.cjs>]
create/update/configure/reconcile/resolve-delivery read JSON from stdin or --input.
get/update/remove/enable/pause/trigger require --id <job-id>.
update/remove require --revision <expected-revision>. create accepts an optional stable --id.
trigger accepts --run-id <stable-run-id> and awaits the result and delivery attempts.
read/deliver/reconcile/resolve-delivery require --id <run-id>.
list/history accept --limit and --offset; history optionally filters --id <job-id>.
run starts scheduling until interrupted; mcp serves stdio without starting its timer.
Provider credentials and fixed delivery destinations belong in the local host adapter.
`;
