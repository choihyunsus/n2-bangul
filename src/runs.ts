// Commit the request and its ownership before invoking any provider or policy callback.
import { randomUUID } from 'node:crypto';
import type { BangulStore } from './store';
import type { HostRegistry } from './hosts';
import type { RunRecord, JobRecord } from './types';
import { getJob } from './jobs';
import { getRun } from './history';
import { ActiveLease, Busy, Cancelled, claimLease } from './lease';
import { digest, encode, identity } from './values';

export interface StartedRun {
  run: RunRecord;
  lease?: ActiveLease;
}
export function beginRun(
  store: BangulStore,
  hosts: HostRegistry,
  jobId: string,
  id: string = randomUUID(),
  trigger: 'manual' | 'scheduled' = 'manual',
): StartedRun {
  identity.parse(id);
  identity.parse(jobId);
  if (trigger !== 'manual' && trigger !== 'scheduled') throw new Error('Invalid trigger');
  const started = store.db.transaction(() => {
    const existing = getRun(store, id);
    if (existing) {
      if (existing.jobId !== jobId || existing.trigger !== trigger)
        throw new Error('Execution ID belongs to another request');
      return { run: existing };
    }
    const job = getJob(store, jobId);
    if (!job) throw new Error('Job was not found in this scope');
    if (
      trigger === 'scheduled' &&
      (!job.enabled || job.nextRunAt === null || job.nextRunAt > Date.now())
    )
      throw new Busy('Scheduled job is no longer due');
    checkCapacity(store, jobId);
    const data = claimLease(store, 'job', jobId, id);
    writeStart(store, hosts, job, id, trigger);
    return { run: getRun(store, id)!, data };
  });
  if (!started.data) return started;
  const lease = new ActiveLease(store, started.data, () => {
    if (!getJob(store, jobId)) throw new Cancelled('Job was removed');
  });
  return { run: started.run, lease };
}
function writeStart(
  store: BangulStore,
  hosts: HostRegistry,
  job: JobRecord,
  id: string,
  trigger: 'manual' | 'scheduled',
): void {
  const snapshot = hosts.snapshot(job.definition, store.settings()),
    json = encode(snapshot, 524288);
  store.db.execute(
    `INSERT INTO bangul_history
    (project,agent,id,job_id,job_revision,input_json,input_hash,trigger_kind,retry_attempt,scheduled_at,started_at,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'running')`,
    [
      ...store.scope,
      id,
      job.id,
      job.revision,
      json,
      digest(json),
      trigger,
      job.consecutiveFailures,
      trigger === 'scheduled' ? job.nextRunAt : null,
      Date.now(),
    ],
  );
}
function checkCapacity(store: BangulStore, jobId: string): void {
  if (
    store.db.query(
      `SELECT 1 FROM bangul_history WHERE project=? AND agent=? AND job_id=?
    AND status IN('running','unknown') LIMIT 1`,
      [...store.scope, jobId],
    ).length
  )
    throw new Busy('Resolve the active or unknown prior execution first');
  const active = store.db.query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM bangul_history WHERE project=? AND agent=? AND status='running'",
    store.scope,
  )[0]!.count;
  if (active >= store.settings().max_concurrent_jobs)
    throw new Busy('Scheduler concurrency limit reached');
}
