// Store UTC instants and explicit zones, rejecting ambiguous one-shot local times before registration.
import { Cron } from 'croner';
import { Temporal } from '@js-temporal/polyfill';
import { line, timestamp } from './values';

export type ScheduleKind = 'at' | 'every' | 'cron';
export interface Schedule {
  schedule_type: ScheduleKind;
  schedule_value: string;
  time_zone: string;
}
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?$/;

export function timeZone(
  value: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const name = line(128).parse(value);
  return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
}
export function atTime(value: string, zone: string): number {
  line(256).parse(value);
  const instant = RFC3339.test(value)
    ? Temporal.Instant.from(value).epochMilliseconds
    : localTime(value, zone);
  return timestamp.parse(instant);
}
function localTime(value: string, zone: string): number {
  if (!LOCAL.test(value)) throw new Error('Expected RFC3339 or an unambiguous local date-time');
  return Temporal.PlainDateTime.from(value.replace(' ', 'T'), {
    overflow: 'reject',
  }).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds;
}
export function nextOccurrence(schedule: Schedule, after: number, initial: boolean): number | null {
  timestamp.parse(after);
  if (schedule.schedule_type === 'at') {
    const instant = atTime(schedule.schedule_value, schedule.time_zone);
    if (initial && instant <= after) throw new Error('One-shot schedules must be in the future');
    return initial ? instant : null;
  }
  if (schedule.schedule_type === 'every') {
    if (!/^\d{1,8}$/.test(schedule.schedule_value)) throw new Error('Invalid interval');
    const seconds = Number(schedule.schedule_value);
    if (seconds < 1 || seconds > 31536000)
      throw new Error('Interval must be 1 through 31536000 seconds');
    return timestamp.parse(after + seconds * 1000);
  }
  return nextCron(schedule.schedule_value, schedule.time_zone, after);
}
function nextCron(pattern: string, zone: string, after: number): number | null {
  line(256).parse(pattern);
  const cron = new Cron(pattern, { timezone: zone, paused: true, unref: true });
  try {
    if (cron.getOnce()) throw new Error('Cron schedules require a cron expression');
    const next = cron.nextRun(new Date(after));
    if (!next) return null;
    if (next.getTime() <= after) throw new Error('Cron expression failed to advance');
    return timestamp.parse(next.getTime());
  } finally {
    cron.stop();
  }
}
