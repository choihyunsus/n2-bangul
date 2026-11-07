// Scheduled tasks accept text requests and bounded retries; capabilities are supplied by the host.
import { z } from 'zod';
import { identity, line, utf8 } from './values';
import { timeZone, nextOccurrence } from './schedule';

export const settingsInput = z.strictObject({
  max_concurrent_jobs: z.int().min(1).max(8).default(3),
  tick_interval_secs: z.int().min(1).max(3600).default(15),
  job_timeout_secs: z.int().min(1).max(3600).default(300),
  catchup_stagger_ms: z.int().min(0).max(60000).default(5000),
});
export const deliveryInput = z.strictObject({
  broadcast: z.boolean().default(true),
  log: z.boolean().default(true),
  webhook: identity.nullable().default(null),
});
export const jobInput = z.strictObject({
  name: line(200),
  description: utf8(4096).default(''),
  schedule_type: z.enum(['at', 'every', 'cron']),
  schedule_value: line(256),
  time_zone: line(128).optional(),
  provider_id: identity.nullable().default(null),
  system_prompt: utf8(32768).nullable().default(null),
  user_message: utf8(65536).refine((value) => !!value.trim(), 'A task message is required'),
  max_output_tokens: z.int().min(1).max(32768).default(2048),
  tools_json: z.union([z.null(), z.array(z.unknown()).max(0)]).default(null),
  delivery: deliveryInput.prefault({}),
  retry_max: z.int().min(0).max(10).default(3),
  retry_backoff_base_secs: z.int().min(1).max(3600).default(30),
});
export type SettingsInput = z.input<typeof settingsInput>;
export type Settings = z.output<typeof settingsInput>;
export type JobInput = z.input<typeof jobInput>;
export type JobDefinition = Omit<z.output<typeof jobInput>, 'time_zone'> & { time_zone: string };
export function parseDefinition(input: unknown): JobDefinition {
  const parsed = jobInput.parse(input);
  const definition = { ...parsed, time_zone: timeZone(parsed.time_zone) };
  nextOccurrence(definition, Date.now(), false);
  return definition;
}
export function resolveJob(
  input: unknown,
  now = Date.now(),
): { definition: JobDefinition; next: number } {
  const definition = parseDefinition(input);
  const next = nextOccurrence(definition, now, true);
  if (next === null) throw new Error('Schedule has no future occurrence');
  return { definition, next };
}
export function retryDelay(baseSeconds: number, failures: number): number {
  return Math.min(3600, baseSeconds * 2 ** Math.max(0, Math.min(10, failures - 1))) * 1000;
}
