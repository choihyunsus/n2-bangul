// An interrupted provider or external delivery requires evidence before replay can create new effects.
import type { BangulStore } from './store';
import type { DeliveryChannel, RunRecord } from './types';
import { readLease, leaseAlive } from './lease';
import { getRun, deliveryChannel } from './history';
import { completeRun, outcomeSchema, type OutcomeInput } from './completion';
import { digest, encode, identity, utf8 } from './values';
import { textColumn } from './sql';

export const deliverySubject = (runId: string, channel: DeliveryChannel) =>
  digest(encode([runId, channel]));
export function recoverInterrupted(store: BangulStore): number {
  return store.db.transaction(() => {
    const runs = store.db.query<{ id: string }>(
      `SELECT ${textColumn('id', 128)} FROM bangul_history
      WHERE project=? AND agent=? AND status='running' ORDER BY started_at,id LIMIT 1025`,
      store.scope,
    );
    if (runs.length > 1024) throw new Error('Too many unresolved executions');
    let recovered = 0;
    for (const item of runs) {
      const run = getRun(store, item.id)!,
        owner = readLease(store, 'job', run.jobId);
      if (owner?.run_id === run.id && leaseAlive(owner)) continue;
      const message =
        'Provider outcome unknown after interrupted ownership; inspect before retrying';
      store.db.execute(
        "UPDATE bangul_history SET status='unknown',finished_at=?,error_message=? WHERE project=? AND agent=? AND id=?",
        [Date.now(), message, ...store.scope, run.id],
      );
      store.db.execute(
        'UPDATE bangul_jobs SET enabled=0,last_error=?,updated_at=? WHERE project=? AND agent=? AND id=?',
        [message, Date.now(), ...store.scope, run.jobId],
      );
      recovered++;
    }
    return recovered + recoverDeliveries(store);
  });
}
function recoverDeliveries(store: BangulStore): number {
  const rows = store.db.query<{ run_id: string; channel: DeliveryChannel }>(
    `SELECT ${textColumn('run_id', 128)},channel FROM bangul_deliveries WHERE project=? AND agent=? AND state='sending' LIMIT 1025`,
    store.scope,
  );
  if (rows.length > 1024) throw new Error('Too many interrupted deliveries');
  let recovered = 0;
  for (const row of rows) {
    identity.parse(row.run_id);
    deliveryChannel.parse(row.channel);
    const owner = readLease(store, 'delivery', deliverySubject(row.run_id, row.channel));
    if (owner?.run_id === row.run_id && leaseAlive(owner)) continue;
    store.db.execute(
      `UPDATE bangul_deliveries SET state=?,finished_at=?,error_message=?
      WHERE project=? AND agent=? AND run_id=? AND channel=?`,
      [
        row.channel === 'log' ? 'pending' : 'unknown',
        Date.now(),
        'Delivery outcome unknown after interrupted ownership',
        ...store.scope,
        row.run_id,
        row.channel,
      ],
    );
    recovered++;
  }
  return recovered;
}
export function reconcileRun(
  store: BangulStore,
  id: string,
  result: OutcomeInput,
  evidence: string,
): RunRecord {
  utf8(8192)
    .refine((text) => !!text.trim(), 'Inspection evidence is required')
    .parse(evidence);
  return store.db.transaction(() => {
    recoverInterrupted(store);
    const run = getRun(store, id);
    const outcome = outcomeSchema.parse(result);
    if (
      run?.reconciliation === evidence &&
      run.status === outcome.status &&
      run.content === outcome.content &&
      run.responseModel === outcome.model &&
      run.error === outcome.error &&
      encode(run.usage) === encode(outcome.usage)
    )
      return run;
    if (!run || run.status !== 'unknown')
      throw new Error('Only an unknown execution can be reconciled');
    return completeRun(store, run, outcome, evidence);
  });
}
