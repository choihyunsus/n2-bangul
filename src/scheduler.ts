// A single timer owner dispatches fresh due rows while all entry points share database capacity.
import { setTimeout as sleep } from 'node:timers/promises';
import type { BangulStore } from './store';
import type { ExecutionPool } from './execution';
import { ActiveLease, Busy, Cancelled, claimLease } from './lease';
import { dueJobs } from './jobs';
import { recoverInterrupted } from './recovery';

export class Scheduler {
  private lease?: ActiveLease;
  private task?: Promise<void>;
  state: 'stopped' | 'catchup' | 'idle' = 'stopped';
  lastError: string | null = null;
  constructor(
    private readonly store: BangulStore,
    private readonly executions: ExecutionPool,
  ) {}
  start(): void {
    if (this.lease) return;
    recoverInterrupted(this.store);
    const lease = new ActiveLease(this.store, claimLease(this.store, 'scheduler', 'main', null));
    this.lease = lease;
    this.state = 'catchup';
    this.lastError = null;
    this.task = this.loop(lease)
      .catch(() => {
        this.lastError =
          'Scheduler loop failed; inspect stored jobs and host diagnostics before restarting';
      })
      .finally(() => {
        lease.release();
        this.lease = undefined;
        this.state = 'stopped';
      });
    void this.task.catch(() => {
      this.lastError = 'Scheduler lease cleanup failed';
    });
  }
  tick(): string[] {
    if (this.lease) return this.dispatch(this.lease);
    recoverInterrupted(this.store);
    const lease = new ActiveLease(this.store, claimLease(this.store, 'scheduler', 'main', null));
    try {
      return this.dispatch(lease);
    } finally {
      lease.release();
    }
  }
  private dispatch(lease: ActiveLease): string[] {
    const submitted: string[] = [];
    lease.assert();
    for (const id of dueJobs(this.store, 8)) {
      lease.controller.signal.throwIfAborted();
      try {
        submitted.push(this.executions.submit(id, undefined, 'scheduled').runId);
      } catch (error) {
        if (!(error instanceof Busy)) throw error;
      }
    }
    return submitted;
  }
  private async loop(lease: ActiveLease): Promise<void> {
    const signal = lease.controller.signal;
    try {
      await this.catchup(lease);
      this.state = 'idle';
      let lastTick = Date.now();
      while (!signal.aborted) {
        await sleep(1000, undefined, { signal });
        if (Date.now() - lastTick >= this.store.settings().tick_interval_secs * 1000) {
          this.dispatch(lease);
          lastTick = Date.now();
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  private async catchup(lease: ActiveLease): Promise<void> {
    const missed = dueJobs(this.store, 5),
      signal = lease.controller.signal;
    for (const [index, id] of missed.entries()) {
      if (index) await sleep(this.store.settings().catchup_stagger_ms, undefined, { signal });
      signal.throwIfAborted();
      lease.assert();
      try {
        await this.executions.trigger(id, undefined, 'scheduled');
      } catch (error) {
        if (!(error instanceof Busy)) throw error;
      }
    }
  }
  async stop(): Promise<void> {
    this.lease?.controller.abort(new Cancelled('Scheduler timer stopped'));
    await this.task;
  }
}
