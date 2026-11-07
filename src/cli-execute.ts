// CLI effects use the same validated public API and await durable completion before exit.
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Bangul } from './bangul';
import type { CliArguments } from './cli-options';
import { readInput } from './cli-options';
import { jobInput, settingsInput } from './config';
import { outcomeSchema } from './completion';
import { deliveryChannel } from './history';
import { identity, utf8 } from './values';

export const reconciliationInput = z.strictObject({
  outcome: outcomeSchema,
  evidence: utf8(8192).min(1),
});
export const deliveryResolution = z.strictObject({
  channel: deliveryChannel,
  action: z.enum(['retry', 'sent', 'skip']),
  evidence: utf8(8000).min(1),
});
export async function execute(
  engine: Bangul,
  command: string,
  values: CliArguments['values'],
  signal: AbortSignal,
): Promise<unknown> {
  if (['create', 'update', 'configure', 'reconcile', 'resolve-delivery'].includes(command))
    return executeInput(engine, command, values, await readInput(values.input, signal));
  switch (command) {
    case 'remove':
      engine.remove(identity.parse(values.id), Number(values.revision));
      return { removed: values.id };
    case 'enable':
      return engine.setEnabled(identity.parse(values.id), true);
    case 'pause':
      return engine.setEnabled(identity.parse(values.id), false);
    case 'get':
      return engine.get(identity.parse(values.id)) ?? null;
    case 'list':
      return engine.list(Number(values.limit ?? 20), Number(values.offset ?? 0));
    case 'trigger':
      return engine.trigger(identity.parse(values.id), values['run-id']);
    case 'history':
      return engine.history(Number(values.limit ?? 20), Number(values.offset ?? 0), values.id);
    case 'read':
      return {
        run: engine.getRun(identity.parse(values.id)),
        deliveries: engine.getDeliveries(identity.parse(values.id)),
      };
    case 'status':
      return engine.status();
    case 'deliver':
      await engine.deliver(identity.parse(values.id));
      return engine.getDeliveries(identity.parse(values.id));
    case 'run':
      await run(engine, signal);
      return { stopped: true };
    default:
      throw new Error('Unsupported command');
  }
}
function executeInput(
  engine: Bangul,
  command: string,
  values: CliArguments['values'],
  value: unknown,
): unknown {
  switch (command) {
    case 'create':
      return engine.create(jobInput.parse(value), values.id);
    case 'update':
      return engine.update(
        identity.parse(values.id),
        jobInput.parse(value),
        Number(values.revision),
      );
    case 'configure':
      return engine.configure(settingsInput.parse(value));
    case 'reconcile': {
      const input = reconciliationInput.parse(value);
      return engine.reconcileRun(identity.parse(values.id), input.outcome, input.evidence);
    }
    case 'resolve-delivery': {
      const input = deliveryResolution.parse(value);
      engine.resolveDelivery(
        identity.parse(values.id),
        input.channel,
        input.action,
        input.evidence,
      );
      return engine.getDeliveries(identity.parse(values.id));
    }
    default:
      throw new Error('Unsupported JSON command');
  }
}
async function run(engine: Bangul, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  engine.start();
  process.stdout.write(JSON.stringify(engine.status()) + '\n');
  while (!signal.aborted) {
    try {
      await sleep(1000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    if (signal.aborted) break;
    const state = engine.status();
    if (state.lastError || state.state === 'stopped')
      throw new Error(state.lastError ?? 'Scheduler stopped unexpectedly');
  }
}
