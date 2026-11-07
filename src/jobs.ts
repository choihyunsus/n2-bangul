// Versioned job definitions preserve edits while old executions retain their own immutable snapshots.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BangulStore } from './store';
import { pagination } from './store';
import type { JobInput } from './config';
import { parseDefinition, resolveJob } from './config';
import type { JobRecord } from './types';
import { digest, encode, hash, identity, parseJson, timestamp, utf8 } from './values';
import { textColumn } from './sql';

const MAX_JOB_BYTES = 262144;
const rowSchema = z.object({
  id: identity,
  definition_json: utf8(MAX_JOB_BYTES),
  definition_hash: hash,
  revision: z.int().min(1),
  enabled: z.union([z.literal(0), z.literal(1)]),
  consecutive_failures: z.int().min(0),
  next_run_at: timestamp.nullable(),
  last_run_at: timestamp.nullable(),
  last_result: utf8(8192).nullable(),
  last_error: utf8(2048).nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: timestamp.nullable(),
});
const COLUMNS = [
  'id',
  textColumn('definition_json', MAX_JOB_BYTES),
  textColumn('definition_hash', 64),
  'revision',
  'enabled',
  'consecutive_failures',
  'next_run_at',
  'last_run_at',
  textColumn('last_result', 8192, true),
  textColumn('last_error', 2048, true),
  'created_at',
  'updated_at',
  'deleted_at',
].join(',');

export function getJob(
  store: BangulStore,
  id: string,
  includeDeleted = false,
): JobRecord | undefined {
  const raw = store.db.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM bangul_jobs WHERE project=? AND agent=? AND id=?`,
    [...store.scope, identity.parse(id)],
  )[0];
  if (!raw) return undefined;
  const row = rowSchema.parse(raw);
  if (digest(row.definition_json) !== row.definition_hash)
    throw new Error('Job definition digest differs');
  const definition = parseDefinition(parseJson(row.definition_json, MAX_JOB_BYTES));
  if (row.deleted_at !== null && !includeDeleted) return undefined;
  return {
    id: row.id,
    definition,
    definitionHash: row.definition_hash,
    revision: row.revision,
    enabled: !!row.enabled,
    consecutiveFailures: row.consecutive_failures,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
export function createJob(
  store: BangulStore,
  input: JobInput,
  id: string = randomUUID(),
): JobRecord {
  identity.parse(id);
  const definition = parseDefinition(input),
    json = encode(definition, MAX_JOB_BYTES),
    definitionHash = digest(json);
  return store.db.transaction(() => {
    const existing = getJob(store, id, true);
    if (existing) {
      if (existing.deletedAt !== null || existing.definitionHash !== definitionHash)
        throw new Error('Job ID already belongs to a different or deleted definition');
      return existing;
    }
    const count = store.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM bangul_jobs WHERE project=? AND agent=? AND deleted_at IS NULL',
      store.scope,
    )[0]!.count;
    if (count >= 1024) throw new Error('A scope supports at most 1024 current jobs');
    const now = Date.now(),
      next = resolveJob(definition, now).next;
    store.db.execute('INSERT INTO bangul_jobs VALUES(?,?,?,?,?,1,1,0,?,NULL,NULL,NULL,?,?,NULL)', [
      ...store.scope,
      id,
      json,
      definitionHash,
      next,
      now,
      now,
    ]);
    return getJob(store, id)!;
  });
}
export function updateJob(
  store: BangulStore,
  id: string,
  input: JobInput,
  expectedRevision: number,
): JobRecord {
  z.int().min(1).parse(expectedRevision);
  const { definition, next } = resolveJob(input),
    json = encode(definition, MAX_JOB_BYTES);
  return store.db.transaction(() => {
    const previous = getJob(store, id);
    if (!previous) throw new Error('Job was not found in this scope');
    if (previous.revision !== expectedRevision) throw new Error('Job revision changed');
    store.db.execute(
      `UPDATE bangul_jobs SET definition_json=?,definition_hash=?,revision=revision+1,
      consecutive_failures=0,next_run_at=?,last_error=NULL,updated_at=? WHERE project=? AND agent=? AND id=? AND revision=?`,
      [json, digest(json), next, Date.now(), ...store.scope, id, expectedRevision],
    );
    return getJob(store, id)!;
  });
}
export function setEnabled(store: BangulStore, id: string, enabled: boolean): JobRecord {
  z.boolean().parse(enabled);
  return store.db.transaction(() => {
    const job = getJob(store, id);
    if (!job) throw new Error('Job was not found in this scope');
    if (
      enabled &&
      store.db.query(
        "SELECT 1 FROM bangul_history WHERE project=? AND agent=? AND job_id=? AND status='unknown' LIMIT 1",
        [...store.scope, id],
      ).length
    )
      throw new Error('Resolve the unknown prior execution before enabling this job');
    const next =
      enabled && job.nextRunAt === null ? resolveJob(job.definition).next : job.nextRunAt;
    store.db.execute(
      'UPDATE bangul_jobs SET enabled=?,next_run_at=?,updated_at=? WHERE project=? AND agent=? AND id=?',
      [Number(enabled), next, Date.now(), ...store.scope, id],
    );
    return getJob(store, id)!;
  });
}
export function removeJob(store: BangulStore, id: string, expectedRevision: number): void {
  z.int().min(1).parse(expectedRevision);
  store.db.transaction(() => {
    const job = getJob(store, id, true);
    if (!job) throw new Error('Job was not found in this scope');
    if (job.deletedAt !== null && job.revision === expectedRevision + 1) return;
    if (job.revision !== expectedRevision) throw new Error('Job revision changed');
    store.db.execute(
      `UPDATE bangul_jobs SET enabled=0,deleted_at=?,updated_at=?,revision=revision+1
      WHERE project=? AND agent=? AND id=? AND revision=?`,
      [Date.now(), Date.now(), ...store.scope, id, expectedRevision],
    );
  });
}
export function listJobs(store: BangulStore, limit = 20, offset = 0) {
  pagination(limit, offset);
  return store.db.transaction(() =>
    store.db
      .query<{ id: string }>(
        `SELECT ${textColumn('id', 128)} FROM bangul_jobs WHERE project=? AND agent=? AND deleted_at IS NULL
      ORDER BY enabled DESC,next_run_at,id LIMIT ? OFFSET ?`,
        [...store.scope, limit, offset],
      )
      .map((row) => {
        const job = getJob(store, row.id)!;
        return {
          id: job.id,
          name: job.definition.name,
          revision: job.revision,
          enabled: job.enabled,
          scheduleType: job.definition.schedule_type,
          scheduleValue: job.definition.schedule_value,
          timeZone: job.definition.time_zone,
          nextRunAt: job.nextRunAt,
          lastError: job.lastError,
          consecutiveFailures: job.consecutiveFailures,
        };
      }),
  );
}
export function dueJobs(store: BangulStore, limit: number): string[] {
  z.int().min(1).max(8).parse(limit);
  return store.db
    .query<{ id: string }>(
      `SELECT ${textColumn('id', 128)} FROM bangul_jobs j WHERE project=? AND agent=? AND enabled=1
      AND deleted_at IS NULL AND next_run_at<=? AND NOT EXISTS(
        SELECT 1 FROM bangul_history h WHERE h.project=j.project AND h.agent=j.agent AND h.job_id=j.id AND h.status IN('running','unknown'))
      ORDER BY next_run_at,id LIMIT ?`,
      [...store.scope, Date.now(), limit],
    )
    .map((row) => identity.parse(row.id));
}
