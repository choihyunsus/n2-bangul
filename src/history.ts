// Bound and verify immutable execution snapshots before exposing outcomes or attempting recovery.
import { z } from 'zod';
import type { BangulStore } from './store';
import { pagination } from './store';
import { jobInput, settingsInput, parseDefinition } from './config';
import { digest, identity, utf8, hash, timestamp, parseJson, line } from './values';
import type { RunRecord, RunSnapshot, DeliveryRecord } from './types';
import { textColumn } from './sql';

export const runStatus = z.enum(['running', 'success', 'error', 'blocked', 'cancelled', 'unknown']);
export const deliveryChannel = z.enum(['log', 'broadcast', 'webhook']);
export const deliveryState = z.enum(['pending', 'sending', 'sent', 'failed', 'unknown', 'skipped']);
export const usageSchema = z.strictObject({
  inputTokens: z.int().min(0).nullable(),
  outputTokens: z.int().min(0).nullable(),
  cachedInputTokens: z.int().min(0).nullable(),
});
const snapshotSchema = z.strictObject({
  job: jobInput.extend({ time_zone: line(128) }),
  settings: settingsInput,
  provider: z.strictObject({
    id: identity.nullable(),
    version: identity.nullable(),
    model: utf8(256).nullable(),
  }),
  policyId: identity,
  deliveryVersions: z.strictObject({
    broadcast: identity.nullable(),
    webhook: identity.nullable(),
  }),
});
const runRow = z.object({
  id: identity,
  job_id: identity,
  job_revision: z.int().min(1),
  input_json: utf8(524288),
  input_hash: hash,
  trigger_kind: z.enum(['manual', 'scheduled']),
  retry_attempt: z.int().min(0),
  scheduled_at: timestamp.nullable(),
  started_at: timestamp,
  finished_at: timestamp.nullable(),
  status: runStatus,
  result_content: utf8(131072).nullable(),
  result_hash: hash.nullable(),
  response_model: utf8(256).nullable(),
  usage_json: utf8(1024).nullable(),
  error_message: utf8(2048).nullable(),
  reconciliation: utf8(8192).nullable(),
});
const RUN_COLUMNS = [
  'id',
  textColumn('job_id', 128),
  'job_revision',
  textColumn('input_json', 524288),
  textColumn('input_hash', 64),
  textColumn('trigger_kind', 16),
  'retry_attempt',
  'scheduled_at',
  'started_at',
  'finished_at',
  textColumn('status', 16),
  textColumn('result_content', 131072, true),
  textColumn('result_hash', 64, true),
  textColumn('response_model', 256, true),
  textColumn('usage_json', 1024, true),
  textColumn('error_message', 2048, true),
  textColumn('reconciliation', 8192, true),
].join(',');

export function readSnapshot(json: string): RunSnapshot {
  const value = snapshotSchema.parse(parseJson(json, 524288));
  return { ...value, job: parseDefinition(value.job) };
}
export function getRun(store: BangulStore, id: string): RunRecord | undefined {
  const raw = store.db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM bangul_history WHERE project=? AND agent=? AND id=?`,
    [...store.scope, identity.parse(id)],
  )[0];
  if (!raw) return undefined;
  const row = runRow.parse(raw);
  if (digest(row.input_json) !== row.input_hash)
    throw new Error('Execution snapshot digest differs');
  if (row.result_content !== null && digest(row.result_content) !== row.result_hash)
    throw new Error('Execution result digest differs');
  if (
    (row.status === 'success') !== (row.result_content !== null) ||
    (row.result_content === null) !== (row.result_hash === null)
  )
    throw new Error('Execution status and result fields are inconsistent');
  if ((row.status === 'running') !== (row.finished_at === null))
    throw new Error('Execution status and finish time are inconsistent');
  return {
    id: row.id,
    jobId: row.job_id,
    jobRevision: row.job_revision,
    snapshot: readSnapshot(row.input_json),
    inputHash: row.input_hash,
    trigger: row.trigger_kind,
    retryAttempt: row.retry_attempt,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    content: row.result_content,
    contentHash: row.result_hash,
    responseModel: row.response_model,
    usage: row.usage_json === null ? null : usageSchema.parse(parseJson(row.usage_json, 1024)),
    error: row.error_message,
    reconciliation: row.reconciliation,
  };
}
export function history(store: BangulStore, limit = 20, offset = 0, jobId?: string) {
  pagination(limit, offset);
  if (jobId !== undefined) identity.parse(jobId);
  return store.db.transaction(() =>
    store.db
      .query<{ id: string }>(
        `SELECT ${textColumn('id', 128)} FROM bangul_history WHERE project=? AND agent=? AND (? IS NULL OR job_id=?)
      ORDER BY started_at DESC,id LIMIT ? OFFSET ?`,
        [...store.scope, jobId ?? null, jobId ?? null, limit, offset],
      )
      .map((row) => {
        const run = getRun(store, row.id)!;
        return {
          id: run.id,
          jobId: run.jobId,
          name: run.snapshot.job.name,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          error: run.error,
          hasResult: run.content !== null,
        };
      }),
  );
}
const deliveryRow = z.object({
  run_id: identity,
  channel: deliveryChannel,
  version: identity.nullable(),
  state: deliveryState,
  attempts: z.int().min(0),
  receipt_id: identity.nullable(),
  error_message: utf8(2048).nullable(),
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  reconciliation: utf8(8192).nullable(),
});
const DELIVERY_COLUMNS = [
  'run_id',
  'channel',
  textColumn('version', 128, true),
  'state',
  'attempts',
  textColumn('receipt_id', 128, true),
  textColumn('error_message', 2048, true),
  'started_at',
  'finished_at',
  textColumn('reconciliation', 8192, true),
].join(',');
export function deliveries(store: BangulStore, runId: string): DeliveryRecord[] {
  return store.db
    .query<Record<string, unknown>>(
      `SELECT ${DELIVERY_COLUMNS} FROM bangul_deliveries
    WHERE project=? AND agent=? AND run_id=? ORDER BY channel LIMIT 4`,
      [...store.scope, identity.parse(runId)],
    )
    .map((raw) => {
      const row = deliveryRow.parse(raw);
      return {
        runId: row.run_id,
        channel: row.channel,
        version: row.version,
        state: row.state,
        attempts: row.attempts,
        receiptId: row.receipt_id,
        error: row.error_message,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        reconciliation: row.reconciliation,
      };
    });
}
