// The public scheduler owns scoped storage, task execution and explicit recovery entry points.
import type { BangulOptions, DeliveryChannel } from './types';
import type { JobInput, SettingsInput } from './config';
import type { OutcomeInput } from './completion';
import { BangulStore } from './store';
import { HostRegistry } from './hosts';
import { ExecutionPool } from './execution';
import { Scheduler } from './scheduler';
import * as jobs from './jobs';
import * as records from './history';
import { reconcileRun, recoverInterrupted } from './recovery';
import { resolveDelivery } from './delivery-store';
import { deliverResult } from './delivery';

export class Bangul {
  private readonly store: BangulStore;
  private readonly hosts: HostRegistry;
  private readonly executions: ExecutionPool;
  private readonly scheduler: Scheduler;
  private readonly shutdown = new AbortController();
  private closing?: Promise<void>;
  private readonly deliveries = new Set<Promise<void>>();
  constructor(options: BangulOptions) {
    this.hosts = new HostRegistry(options);
    this.store = new BangulStore(options, options.settings);
    try {
      recoverInterrupted(this.store);
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.executions = new ExecutionPool(this.store, this.hosts);
    this.scheduler = new Scheduler(this.store, this.executions);
  }
  private check(): void {
    if (this.closing || this.shutdown.signal.aborted)
      throw new Error('Scheduler is closing or closed');
  }
  create(input: JobInput, id?: string) {
    this.check();
    return jobs.createJob(this.store, input, id);
  }
  get(id: string) {
    this.check();
    return jobs.getJob(this.store, id);
  }
  list(limit?: number, offset?: number) {
    this.check();
    return jobs.listJobs(this.store, limit, offset);
  }
  update(id: string, input: JobInput, expectedRevision: number) {
    this.check();
    return jobs.updateJob(this.store, id, input, expectedRevision);
  }
  setEnabled(id: string, enabled: boolean) {
    this.check();
    return jobs.setEnabled(this.store, id, enabled);
  }
  remove(id: string, expectedRevision: number) {
    this.check();
    return jobs.removeJob(this.store, id, expectedRevision);
  }
  settings() {
    this.check();
    return this.store.settings();
  }
  configure(input: SettingsInput) {
    this.check();
    this.store.configure(input);
    return this.store.settings();
  }
  submit(jobId: string, runId?: string) {
    this.check();
    return this.executions.submit(jobId, runId);
  }
  trigger(jobId: string, runId?: string) {
    this.check();
    return this.executions.trigger(jobId, runId);
  }
  start() {
    this.check();
    if (!this.hosts.providers.size)
      throw new Error('Register a provider before starting scheduling');
    this.scheduler.start();
  }
  stop() {
    this.check();
    return this.scheduler.stop();
  }
  tick() {
    this.check();
    if (!this.hosts.providers.size)
      throw new Error('Register a provider before dispatching scheduled tasks');
    return this.scheduler.tick();
  }
  history(limit?: number, offset?: number, jobId?: string) {
    this.check();
    return records.history(this.store, limit, offset, jobId);
  }
  getRun(id: string) {
    this.check();
    return records.getRun(this.store, id);
  }
  getDeliveries(id: string) {
    this.check();
    return records.deliveries(this.store, id);
  }
  recover() {
    this.check();
    return recoverInterrupted(this.store);
  }
  reconcileRun(id: string, outcome: OutcomeInput, evidence: string) {
    this.check();
    return reconcileRun(this.store, id, outcome, evidence);
  }
  resolveDelivery(
    id: string,
    channel: DeliveryChannel,
    action: 'retry' | 'sent' | 'skip',
    evidence: string,
  ) {
    this.check();
    resolveDelivery(this.store, id, channel, action, evidence);
  }
  deliver(id: string): Promise<void> {
    this.check();
    if (this.deliveries.size >= 16) throw new Error('Too many delivery requests');
    const task = deliverResult(this.store, this.hosts, id, this.shutdown.signal).finally(() =>
      this.deliveries.delete(task),
    );
    this.deliveries.add(task);
    void task.catch(() => {});
    return task;
  }
  status() {
    this.check();
    const counts = this.store.db.query<{ status: string; count: number }>(
      'SELECT status,COUNT(*) AS count FROM bangul_history WHERE project=? AND agent=? GROUP BY status',
      this.store.scope,
    );
    return {
      state: this.scheduler.state,
      localActive: this.executions.size,
      counts,
      lastError: this.executions.lastError ?? this.scheduler.lastError,
      settings: this.store.settings(),
    };
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = Promise.resolve().then(() => this.finishClose());
    return this.closing;
  }
  private async finishClose(): Promise<void> {
    this.shutdown.abort(new Error('Scheduler is closing'));
    const settled = await Promise.allSettled([
      this.scheduler.stop(),
      this.executions.close(),
      ...this.deliveries,
    ]);
    this.store.close();
    if (settled.some((item) => item.status === 'rejected'))
      throw new Error('Scheduler shutdown encountered persistence failures');
  }
}
