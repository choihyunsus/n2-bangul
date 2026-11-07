// Owned tasks preserve their durable start, finish before shutdown and expose background failures.
import { randomUUID } from 'node:crypto';
import type { BangulStore } from './store';
import type { HostRegistry } from './hosts';
import type { RunRecord } from './types';
import { beginRun, type StartedRun } from './runs';
import { ActiveLease, Busy, Cancelled } from './lease';
import { invokeText } from './invoke';
import { completeRun } from './completion';
import { deliverResult } from './delivery';
import { recoverInterrupted } from './recovery';
import { getRun } from './history';
import { getJob } from './jobs';

interface ActiveTask {
  controller: AbortController;
  promise: Promise<RunRecord>;
}
export interface Submission {
  runId: string;
  status: RunRecord['status'];
  started: boolean;
}
export class ExecutionPool {
  private readonly active = new Map<string, ActiveTask>();
  private closing = false;
  lastError: string | null = null;
  constructor(
    private readonly store: BangulStore,
    private readonly hosts: HostRegistry,
  ) {}
  get size(): number {
    return this.active.size;
  }
  submit(
    jobId: string,
    runId: string = randomUUID(),
    trigger: 'manual' | 'scheduled' = 'manual',
  ): Submission {
    if (this.closing) throw new Error('Scheduler is closing');
    if (this.active.size >= 16 && !getRun(this.store, runId))
      throw new Busy('Local execution cleanup limit reached');
    recoverInterrupted(this.store);
    const started = beginRun(this.store, this.hosts, jobId, runId, trigger);
    if (started.lease) {
      const controller = new AbortController();
      const promise = this.execute(started, controller.signal).finally(() =>
        this.active.delete(runId),
      );
      this.active.set(runId, { controller, promise });
      void promise.catch(() => {
        this.lastError =
          'Execution failed to finish durably; inspect its history and recover ownership';
      });
    }
    return { runId, status: started.run.status, started: !!started.lease };
  }
  async trigger(
    jobId: string,
    runId?: string,
    trigger: 'manual' | 'scheduled' = 'manual',
  ): Promise<RunRecord> {
    const submission = this.submit(jobId, runId, trigger),
      task = this.active.get(submission.runId);
    if (task) return task.promise;
    const run = getRun(this.store, submission.runId)!;
    if (run.status === 'running')
      throw new Busy('Execution is owned by another scheduler instance');
    return run;
  }
  private async execute(started: StartedRun, signal: AbortSignal): Promise<RunRecord> {
    const lease: ActiveLease = started.lease!,
      combined = AbortSignal.any([signal, lease.controller.signal]);
    try {
      if (!getJob(this.store, started.run.jobId))
        lease.controller.abort(new Cancelled('Job was removed'));
      const outcome = await invokeText(this.store, this.hosts, started.run, combined);
      const result = lease.mutate(() => completeRun(this.store, started.run, outcome));
      await deliverResult(this.store, this.hosts, result.id, combined);
      return result;
    } finally {
      lease.release();
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const tasks = [...this.active.values()];
    for (const task of tasks) task.controller.abort(new Cancelled('Scheduler is closing'));
    const settled = await Promise.allSettled(tasks.map((task) => task.promise));
    if (settled.some((task) => task.status === 'rejected'))
      throw new Error('Some tasks failed to finish durably');
  }
}
