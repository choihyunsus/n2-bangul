// External delivery failures stay separate from AI completion and never rerun the model.
import type { BangulStore } from './store';
import type { HostRegistry } from './hosts';
import type { DeliveryChannel, RunRecord, DeliveryEvent } from './types';
import { getRun, deliveries } from './history';
import { beginDelivery, setDelivery, logResult } from './delivery-store';
import { ActiveLease, Busy } from './lease';
import { deadline } from './deadline';
import { digest, encode } from './values';

export async function deliverResult(
  store: BangulStore,
  hosts: HostRegistry,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const run = getRun(store, runId);
  if (!run || run.status !== 'success') return;
  for (const channel of ['log', 'broadcast', 'webhook'] as const) {
    if (signal.aborted) return;
    let lease: ActiveLease | undefined;
    try {
      lease = beginDelivery(store, runId, channel);
    } catch (error) {
      if (error instanceof Busy) continue;
      throw error;
    }
    if (!lease) continue;
    try {
      if (channel === 'log') deliverLog(store, run, lease);
      else await deliverExternal(store, hosts, run, channel, lease, signal);
    } finally {
      lease.release();
    }
  }
}
function deliverLog(store: BangulStore, run: RunRecord, lease: ActiveLease): void {
  try {
    lease.mutate(() => {
      const receiptId = logResult(store, run);
      setDelivery(store, run.id, 'log', 'sent', receiptId, null);
    });
  } catch {
    lease.mutate(() =>
      setDelivery(store, run.id, 'log', 'failed', null, 'Memory log transaction failed'),
    );
  }
}
async function deliverExternal(
  store: BangulStore,
  hosts: HostRegistry,
  run: RunRecord,
  channel: 'broadcast' | 'webhook',
  lease: ActiveLease,
  signal: AbortSignal,
): Promise<void> {
  const target =
    channel === 'broadcast'
      ? hosts.broadcast
      : hosts.webhooks.get(run.snapshot.job.delivery.webhook ?? '');
  const receipt = deliveries(store, run.id).find((row) => row.channel === channel)!;
  if (!target || target.version !== receipt.version) {
    lease.mutate(() =>
      setDelivery(
        store,
        run.id,
        channel,
        'failed',
        null,
        'Delivery target is unavailable or changed',
      ),
    );
    return;
  }
  const idempotencyKey = digest(encode([...store.scope, run.id, channel]));
  let sent = false;
  try {
    await deadline(AbortSignal.any([signal, lease.controller.signal]), 10000, (deliverySignal) =>
      target.send(Object.freeze(deliveryEvent(store, run)), {
        signal: deliverySignal,
        idempotencyKey,
      }),
    );
    sent = true;
  } catch {
    lease.mutate(() =>
      setDelivery(
        store,
        run.id,
        channel,
        'unknown',
        null,
        'Host delivery did not confirm completion; inspect before resending',
      ),
    );
  }
  if (sent) lease.mutate(() => setDelivery(store, run.id, channel, 'sent', idempotencyKey, null));
}
function deliveryEvent(store: BangulStore, run: RunRecord): DeliveryEvent {
  if (run.content === null || !run.contentHash || run.finishedAt === null)
    throw new Error('Completed result is missing');
  return {
    type: 'bangul_result',
    project: store.scope[0],
    agent: store.scope[1],
    run_id: run.id,
    job_id: run.jobId,
    job_name: run.snapshot.job.name,
    content: run.content,
    result_hash: run.contentHash,
    completed_at: run.finishedAt,
  };
}
