#!/usr/bin/env node
// CLI and MCP shutdown wait for cancellation records and independent delivery receipts.
import { Bangul } from './bangul';
import { argumentsForCli, engineOptions, COMMANDS, HELP } from './cli-options';
import { execute } from './cli-execute';

async function main(): Promise<void> {
  const input = argumentsForCli(process.argv.slice(2)),
    command = input.positionals[0];
  if (input.values.version) {
    process.stdout.write('1.0.0\n');
    return;
  }
  if (input.values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (input.positionals.length !== 1 || !COMMANDS.includes(command as (typeof COMMANDS)[number]))
    throw new Error('Unknown command; use --help');
  const engine = new Bangul(await engineOptions(input.values));
  if (command === 'mcp') {
    await serve(engine);
    return;
  }
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    void engine.close().catch(reportFailure);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await execute(engine, command, input.values, controller.signal);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (command === 'trigger' && (result as { status: string }).status !== 'success')
      process.exitCode = 2;
  } finally {
    await engine.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
async function serve(engine: Bangul): Promise<void> {
  const { createMcpServer } = await import('./mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createMcpServer(engine);
  const stop = () => {
    void server
      .close()
      .catch(reportFailure)
      .finally(() => engine.close())
      .catch(reportFailure);
  };
  server.server.onclose = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    void engine.close().catch(reportFailure);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await engine.close();
    throw error;
  }
}
function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    JSON.stringify({ error: Array.from(message).slice(0, 1000).join('') }) + '\n',
  );
  process.exitCode = 1;
}
main().catch(reportFailure);
