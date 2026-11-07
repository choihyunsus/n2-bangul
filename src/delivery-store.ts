// Delivery receipts fence effects independently of the completed provider request.
import { z } from 'zod';
import type { BangulStore } from './store';
import type { DeliveryChannel, DeliveryState, RunRecord } from './types';
import { deliveries, getRun, deliveryChannel } from './history';
import { getJob } from './jobs';
import { ActiveLease, Busy, claimLease } from './lease';
import { deliverySubject, recoverInterrupted } from './recovery';
import { utf8 } from './values';

export function beginDelivery(
  store: BangulStore,
  runId: string,
  channel: DeliveryChannel,
): ActiveLease | undefined {
  deliveryChannel.parse(channel);
  const data = store.db.transaction(() => {
    const run = getRun(store, runId);
    if (!run || run.status !== 'success')
      throw new Error('Delivery requires a completed text result');
    const receipt = deliveries(store, runId).find((row) => row.channel === channel);
    if (!receipt || receipt.state !== 'pending') return undefined;
    if (!getJob(store, run.jobId)) {
      setDelivery(store, runId, channel, 'skipped', null, 'Job was removed before delivery');
      return undefined;
    }
    const count = store.db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM bangul_deliveries WHERE project=? AND agent=? AND state='sending'",
      store.scope,
    )[0]!.count;
    if (count >= 16) throw new Busy('Delivery concurrency limit reached');
    const lease = claimLease(store, 'delivery', deliverySubject(runId, channel), runId);
    store.db.execute(
      `UPDATE bangul_deliveries SET state='sending',attempts=attempts+1,started_at=?,finished_at=NULL,error_message=NULL
      WHERE project=? AND agent=? AND run_id=? AND channel=?`,
      [Date.now(), ...store.scope, runId, channel],
    );
    return lease;
  });
  return data ? new ActiveLease(store, data) : undefined;
}
export function setDelivery(
  store: BangulStore,
  runId: string,
  channel: DeliveryChannel,
  state: DeliveryState,
  receiptId: string | null,
  error: string | null,
): void {
  const changed = store.db.execute(
    `UPDATE bangul_deliveries SET state=?,receipt_id=?,error_message=?,finished_at=?
    WHERE project=? AND agent=? AND run_id=? AND channel=?`,
    [state, receiptId, error, Date.now(), ...store.scope, runId, channel],
  );
  if (changed !== 1) throw new Error('Delivery receipt is missing');
}
export function logResult(store: BangulStore, run: RunRecord): string {
  const context = JSON.stringify({
    kind: 'scheduled_text',
    verified: false,
    runId: run.id,
    jobId: run.jobId,
    provider: run.snapshot.provider,
    model: run.responseModel,
    policyId: run.snapshot.policyId,
    request: run.snapshot.job.user_message,
    response: run.content,
    resultHash: run.contentHash,
    completedAt: run.finishedAt,
  });
  return store.memory.insertExperience({
    project: store.scope[0],
    agent: store.scope[1],
    sessionId: run.id,
    type: 'pattern',
    category: 'scheduled_text',
    severity: 'info',
    context,
    action: 'scheduled_text',
    outcome: 'unverified_model_output',
    sourceRef: `bangul:${run.id}`,
  }).id;
}
export function resolveDelivery(
  store: BangulStore,
  runId: string,
  channel: DeliveryChannel,
  action: 'retry' | 'sent' | 'skip',
  evidence: string,
): void {
  deliveryChannel.parse(channel);
  z.enum(['retry', 'sent', 'skip']).parse(action);
  utf8(8000)
    .refine((value) => !!value.trim(), 'Inspection evidence is required')
    .parse(evidence);
  const resolution = `${action}\n${evidence}`;
  store.db.transaction(() => {
    recoverInterrupted(store);
    const row = deliveries(store, runId).find((entry) => entry.channel === channel);
    if (row?.reconciliation === resolution) return;
    if (!row || !['unknown', 'failed'].includes(row.state))
      throw new Error('Only an unknown or failed delivery can be resolved');
    if (action === 'sent' && channel === 'log')
      throw new Error('A memory log requires its atomic database receipt');
    const state = action === 'retry' ? 'pending' : action === 'sent' ? 'sent' : 'skipped';
    store.db.execute(
      `UPDATE bangul_deliveries SET state=?,error_message=NULL,finished_at=?,reconciliation=?
      WHERE project=? AND agent=? AND run_id=? AND channel=?`,
      [state, action === 'retry' ? null : Date.now(), resolution, ...store.scope, runId, channel],
    );
  });
}
