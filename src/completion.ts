// Provider history, future scheduling and pending delivery receipts form one atomic completion.
import { z } from 'zod';
import type { BangulStore } from './store';
import type { RunRecord, DeliveryChannel } from './types';
import { getRun, usageSchema } from './history';
import { nextOccurrence } from './schedule';
import { retryDelay } from './config';
import { digest, encode, utf8, timestamp } from './values';

export const outcomeSchema = z
  .strictObject({
    status: z.enum(['success', 'error', 'blocked', 'cancelled']),
    content: utf8(131072).nullable().default(null),
    model: utf8(256).nullable().default(null),
    usage: usageSchema.nullable().default(null),
    error: utf8(2048).nullable().default(null),
  })
  .refine(
    (value) => (value.status === 'success') === (value.content !== null),
    'Only success contains a result',
  );
export type Outcome = z.output<typeof outcomeSchema>;
export type OutcomeInput = z.input<typeof outcomeSchema>;

// The caller holds the job lease or an explicit reconciliation transaction.
export function completeRun(
  store: BangulStore,
  run: RunRecord,
  input: OutcomeInput,
  evidence: string | null = null,
): RunRecord {
  const outcome = outcomeSchema.parse(input),
    now = Date.now();
  const changed = store.db.execute(
    `UPDATE bangul_history SET status=?,finished_at=?,result_content=?,result_hash=?,
    response_model=?,usage_json=?,error_message=?,reconciliation=? WHERE project=? AND agent=? AND id=? AND status IN('running','unknown')`,
    [
      outcome.status,
      now,
      outcome.content,
      outcome.content === null ? null : digest(outcome.content),
      outcome.model,
      outcome.usage === null ? null : encode(outcome.usage, 1024),
      outcome.error,
      evidence,
      ...store.scope,
      run.id,
    ],
  );
  if (changed !== 1) throw new Error('Execution is missing or already finalized');
  updateSchedule(store, run, outcome, now);
  if (outcome.status === 'success') {
    const versions = run.snapshot.deliveryVersions,
      delivery = run.snapshot.job.delivery;
    addDelivery(store, run.id, 'log', 'mimir-log-v1', delivery.log);
    addDelivery(
      store,
      run.id,
      'broadcast',
      versions.broadcast,
      delivery.broadcast && versions.broadcast !== null,
    );
    addDelivery(store, run.id, 'webhook', versions.webhook, delivery.webhook !== null);
  }
  return getRun(store, run.id)!;
}
function addDelivery(
  store: BangulStore,
  runId: string,
  channel: DeliveryChannel,
  version: string | null,
  enabled: boolean,
): void {
  store.db.execute(
    `INSERT INTO bangul_deliveries(project,agent,run_id,channel,version,state)
    VALUES(?,?,?,?,?,?)`,
    [...store.scope, runId, channel, version, enabled ? 'pending' : 'skipped'],
  );
}
function updateSchedule(store: BangulStore, run: RunRecord, outcome: Outcome, now: number): void {
  const job = run.snapshot.job;
  let failures = outcome.status === 'success' ? 0 : run.retryAttempt;
  let next: number | null;
  if (outcome.status === 'error') {
    failures++;
    next =
      failures > job.retry_max
        ? null
        : timestamp.parse(now + retryDelay(job.retry_backoff_base_secs, failures));
  } else next = nextOccurrence(job, now, false);
  store.db.execute(
    `UPDATE bangul_jobs SET last_run_at=?,last_result=?,last_error=?,consecutive_failures=?,next_run_at=?,
    enabled=CASE WHEN ? THEN 0 ELSE enabled END,updated_at=? WHERE project=? AND agent=? AND id=? AND revision=? AND deleted_at IS NULL`,
    [
      run.startedAt,
      outcome.content === null ? null : preview(outcome.content),
      outcome.error,
      failures,
      next,
      Number(next === null),
      now,
      ...store.scope,
      run.jobId,
      run.jobRevision,
    ],
  );
}
function preview(text: string): string {
  let result = '',
    bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > 8189) return result + '...';
    result += character;
  }
  return result;
}
