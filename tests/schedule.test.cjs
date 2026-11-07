// Explicit zones and historical DST transitions exercise actual Croner and Temporal behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextOccurrence, atTime, timeZone } = require('../dist/schedule');
const { resolveJob, settingsInput, retryDelay } = require('../dist/config');
const input = (overrides) => ({
  name: 'fixture',
  user_message: 'Return a short text',
  schedule_type: 'every',
  schedule_value: '60',
  ...overrides,
});
const instant = (text) => Date.parse(text);
const cron = (pattern, zone, after) =>
  nextOccurrence(
    { schedule_type: 'cron', schedule_value: pattern, time_zone: zone },
    instant(after),
    false,
  );

test('offset timestamps and explicit local zones identify the same one-shot instant', () => {
  const expected = instant('2030-01-01T00:00:00Z');
  assert.equal(atTime('2030-01-01T00:00:00Z', 'Asia/Seoul'), expected);
  assert.equal(atTime('2030-01-01T09:00:00+09:00', 'America/New_York'), expected);
  assert.equal(atTime('2030-01-01 09:00:00', 'Asia/Seoul'), expected);
  assert.equal(timeZone('Asia/Seoul'), 'Asia/Seoul');
});

test('invalid dates, nonexistent local times and repeated local times require corrected input', () => {
  for (const [value, zone] of [
    ['2030-02-30 09:00:00', 'Asia/Seoul'],
    ['2030-02-30T09:00:00Z', 'UTC'],
    ['2024-03-10 02:30:00', 'America/New_York'],
    ['2024-11-03 01:30:00', 'America/New_York'],
    ['2030-01-01T00:00:60Z', 'UTC'],
    ['not-a-date', 'UTC'],
  ])
    assert.throws(() => atTime(value, zone));
  assert.throws(() => timeZone('Unknown/Zone'));
  assert.equal(atTime('2024-03-10 03:30:00', 'America/New_York'), instant('2024-03-10T07:30:00Z'));
});

test('cron uses its stored time zone and computes dates without a background timer', () => {
  assert.equal(
    cron('0 9 * * *', 'Asia/Seoul', '2026-01-01T00:00:00Z'),
    instant('2026-01-02T00:00:00Z'),
  );
  assert.equal(
    cron('@daily', 'Asia/Seoul', '2026-01-01T00:00:00Z'),
    instant('2026-01-01T15:00:00Z'),
  );
  assert.equal(
    cron('0 0 0 1 1 * 9999', 'Asia/Seoul', '2026-01-01T00:00:00Z'),
    instant('9998-12-31T15:00:00Z'),
  );
  assert.throws(
    () => cron('2030-01-01T00:00:00Z', 'UTC', '2026-01-01T00:00:00Z'),
    /cron expression/,
  );
});

test('Croner fixed-time DST rules and interval rules preserve chronological progression', () => {
  assert.equal(
    cron('0 30 2 * * *', 'America/New_York', '2024-03-10T05:00:00Z'),
    instant('2024-03-10T07:00:00Z'),
  );
  const first = cron('0 30 1 * * *', 'America/New_York', '2024-11-03T04:00:00Z');
  assert.equal(first, instant('2024-11-03T05:30:00Z'));
  assert.equal(
    cron('0 30 1 * * *', 'America/New_York', new Date(first).toISOString()),
    instant('2024-11-04T06:30:00Z'),
  );
  assert.equal(
    cron('0 */15 1 * * *', 'America/New_York', '2024-11-03T05:45:00Z'),
    instant('2024-11-03T06:00:00Z'),
  );
});

test('finite cron exhaustion can finalize a completed job and initial impossible schedules fail', () => {
  assert.equal(cron('0 0 0 1 1 * 2025', 'UTC', '2026-01-01T00:00:00Z'), null);
  assert.equal(cron('0 0 31 2 *', 'UTC', '2026-01-01T00:00:00Z'), null);
  assert.throws(
    () =>
      resolveJob(input({ schedule_type: 'cron', schedule_value: '0 0 31 2 *', time_zone: 'UTC' })),
    /future/,
  );
  assert.throws(
    () => resolveJob(input({ schedule_type: 'at', schedule_value: '2020-01-01T00:00:00Z' })),
    /future/,
  );
});

test('bounded intervals and retry backoff cover the supported range without overflow', () => {
  const now = instant('2026-01-01T00:00:00Z');
  assert.equal(resolveJob(input({ schedule_value: '1' }), now).next, now + 1000);
  for (const schedule_value of ['0', '31536001', '1e3', '-1', '1.5'])
    assert.throws(() => resolveJob(input({ schedule_value }), now));
  assert.equal(retryDelay(30, 1), 30000);
  assert.equal(retryDelay(30, 3), 120000);
  assert.equal(retryDelay(3600, 10), 3600000);
});

test('job definitions enforce text-only requests and reject malformed configuration before storage', () => {
  for (const value of [
    { name: '' },
    { user_message: ' ' },
    { user_message: '\ud800' },
    { tools_json: [{ name: 'execute' }] },
    { tools_json: {} },
    { retry_max: 11 },
    { retry_backoff_base_secs: 0 },
    { time_zone: 'Bad/Zone' },
    { max_output_tokens: 32769 },
    { project: 'foreign' },
  ])
    assert.throws(() => resolveJob(input(value)));
  assert.deepEqual(resolveJob(input({ tools_json: [] })).definition.tools_json, []);
  for (const value of [
    { max_concurrent_jobs: 9 },
    { tick_interval_secs: 0 },
    { job_timeout_secs: 3601 },
    { catchup_stagger_ms: 60001 },
  ])
    assert.throws(() => settingsInput.parse(value));
});
