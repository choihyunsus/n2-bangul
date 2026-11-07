// Stored task snapshots identify the owner, selected provider and separately versioned delivery targets.
import type { ModelProvider, ModelUsage } from 'n2-gumiho';
import type { JobDefinition, Settings, SettingsInput } from './config';

export interface StoreOptions {
  dbPath: string;
  project: string;
  agent: string;
}
export interface JobRecord {
  id: string;
  definition: JobDefinition;
  definitionHash: string;
  revision: number;
  enabled: boolean;
  consecutiveFailures: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
export type RunStatus = 'running' | 'success' | 'error' | 'blocked' | 'cancelled' | 'unknown';
export type DeliveryChannel = 'log' | 'broadcast' | 'webhook';
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped';
export interface RunSnapshot {
  job: JobDefinition;
  settings: Settings;
  provider: { id: string | null; version: string | null; model: string | null };
  policyId: string;
  deliveryVersions: { broadcast: string | null; webhook: string | null };
}
export interface RunRecord {
  id: string;
  jobId: string;
  jobRevision: number;
  snapshot: RunSnapshot;
  inputHash: string;
  trigger: 'manual' | 'scheduled';
  retryAttempt: number;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  content: string | null;
  contentHash: string | null;
  responseModel: string | null;
  usage: ModelUsage | null;
  error: string | null;
  reconciliation: string | null;
}
export interface DeliveryRecord {
  runId: string;
  channel: DeliveryChannel;
  version: string | null;
  state: DeliveryState;
  attempts: number;
  receiptId: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  reconciliation: string | null;
}
export interface DeliveryEvent {
  type: 'bangul_result';
  project: string;
  agent: string;
  run_id: string;
  job_id: string;
  job_name: string;
  content: string;
  result_hash: string;
  completed_at: number;
}
export interface DeliveryContext {
  readonly signal: AbortSignal;
  readonly idempotencyKey: string;
}
export interface DeliveryTarget {
  id: string;
  version: string;
  send(event: Readonly<DeliveryEvent>, context: DeliveryContext): void | Promise<void>;
}
export interface RunPolicy {
  id: string;
  check(
    job: Readonly<JobDefinition>,
    context: {
      readonly project: string;
      readonly agent: string;
      readonly runId: string;
      readonly signal: AbortSignal;
    },
  ): { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;
}
export interface BangulOptions extends StoreOptions {
  provider?: ModelProvider;
  providers?: ModelProvider[];
  policy?: RunPolicy;
  broadcast?: DeliveryTarget;
  webhooks?: DeliveryTarget[];
  settings?: SettingsInput;
}
