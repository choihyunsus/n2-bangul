// Nonce leases coordinate scheduler, job and delivery ownership across processes sharing the database.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BangulStore } from './store';
import { identity, timestamp } from './values';
import { textColumn } from './sql';

const LEASE_MS = 30000;
export const leaseKinds = z.enum(['scheduler', 'job', 'delivery']);
export type LeaseKind = z.output<typeof leaseKinds>;
const leaseRow = z.object({
  kind: leaseKinds,
  subject_id: identity,
  run_id: identity.nullable(),
  nonce: identity,
  process_id: z.int().min(1).max(2147483647),
  expires_at: timestamp,
});
export type LeaseData = z.output<typeof leaseRow>;
export class Busy extends Error {}
export class Cancelled extends Error {}

export function readLease(
  store: BangulStore,
  kind: LeaseKind,
  subject: string,
): LeaseData | undefined {
  const row = store.db.query<Record<string, unknown>>(
    `SELECT kind,subject_id,${textColumn('run_id', 128, true)},${textColumn('nonce', 128)},process_id,expires_at
      FROM bangul_leases WHERE project=? AND agent=? AND kind=? AND subject_id=?`,
    [...store.scope, leaseKinds.parse(kind), identity.parse(subject)],
  )[0];
  return row ? leaseRow.parse(row) : undefined;
}
export function leaseAlive(row: LeaseData | undefined): boolean {
  if (!row || row.expires_at <= Date.now()) return false;
  try {
    process.kill(row.process_id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function claimLease(
  store: BangulStore,
  kind: LeaseKind,
  subject: string,
  runId: string | null,
): LeaseData {
  return store.db.transaction(() => {
    if (leaseAlive(readLease(store, kind, subject)))
      throw new Busy('This scheduler operation already has an owner');
    const row = leaseRow.parse({
      kind,
      subject_id: subject,
      run_id: runId,
      nonce: randomUUID(),
      process_id: process.pid,
      expires_at: Date.now() + LEASE_MS,
    });
    store.db.execute('INSERT OR REPLACE INTO bangul_leases VALUES(?,?,?,?,?,?,?,?)', [
      ...store.scope,
      row.kind,
      row.subject_id,
      row.run_id,
      row.nonce,
      row.process_id,
      row.expires_at,
    ]);
    return row;
  });
}
export class ActiveLease {
  readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private renewedAt = Date.now();
  constructor(
    private readonly store: BangulStore,
    readonly data: LeaseData,
    private readonly check?: () => void,
  ) {
    this.timer = setInterval(() => this.heartbeat(), 1000);
    this.timer.unref();
  }
  assert(): void {
    const row = readLease(this.store, this.data.kind, this.data.subject_id);
    if (!row || row.nonce !== this.data.nonce || row.expires_at <= Date.now())
      throw new Error('Scheduler lease was lost or expired');
  }
  mutate<T>(operation: () => T): T {
    return this.store.db.transaction(() => {
      this.assert();
      return operation();
    });
  }
  private heartbeat(): void {
    try {
      this.mutate(() => {
        if (Date.now() - this.renewedAt >= LEASE_MS / 3) {
          this.store.db.execute(
            `UPDATE bangul_leases SET expires_at=? WHERE project=? AND agent=? AND kind=? AND subject_id=? AND nonce=?`,
            [
              Date.now() + LEASE_MS,
              ...this.store.scope,
              this.data.kind,
              this.data.subject_id,
              this.data.nonce,
            ],
          );
          this.renewedAt = Date.now();
        }
      });
    } catch (error) {
      clearInterval(this.timer);
      this.controller.abort(error);
      return;
    }
    if (!this.controller.signal.aborted) {
      try {
        this.check?.();
      } catch (error) {
        this.controller.abort(error);
      }
    }
  }
  release(): void {
    clearInterval(this.timer);
    this.controller.abort(new Cancelled('Operation ended'));
    this.store.db.execute(
      'DELETE FROM bangul_leases WHERE project=? AND agent=? AND kind=? AND subject_id=? AND nonce=?',
      [...this.store.scope, this.data.kind, this.data.subject_id, this.data.nonce],
    );
  }
}
