// Real timer dispatch, finite schedules and shutdown share the manual execution invariants.
const test = require('node:test');
const assert = require('node:assert/strict');
const { app, reply, provider, waitFor } = require('./runtime-helpers.cjs');
const { task } = require('./helpers.cjs');
const { Bangul, Busy } = require('../dist/library');

test('the live timer dispatches a due job and another instance observes the scheduler lease', async (t) => {
  let models = 0;
  const { bangul, options, track } = app(t, {
    provider: provider(async () => {
      models++;
      return reply();
    }),
    settings: { tick_interval_secs: 1, catchup_stagger_ms: 0 },
  });
  bangul.create(task({ schedule_value: '1' }), 'job');
  bangul.start();
  const other = track(new Bangul({ ...options, provider: provider(async () => reply()) }));
  assert.throws(() => other.start(), Busy);
  await waitFor(() => bangul.history().some((run) => run.status === 'success'), 5000);
  bangul.setEnabled('job', false);
  await bangul.stop();
  assert.equal(models, 1);
  assert.equal(bangul.status().state, 'stopped');
  other.start();
  await other.stop();
});

test('startup catch-up processes at most five missed jobs before normal polling', async (t) => {
  const { bangul, store } = app(t, {
    provider: provider(async () => reply()),
    settings: { tick_interval_secs: 3600, catchup_stagger_ms: 0 },
  });
  for (let index = 0; index < 7; index++)
    bangul.create(task({ schedule_value: '3600' }), `job-${index}`);
  store.db.execute('UPDATE bangul_jobs SET next_run_at=?', [Date.now() - 1000]);
  bangul.start();
  await waitFor(() => bangul.status().state === 'idle');
  await bangul.stop();
  assert.equal(bangul.history().length, 5);
  assert.ok(bangul.history().every((run) => run.status === 'success'));
});

test('completed one-shot and final cron occurrences disable cleanly without losing their results', async (t) => {
  let now = Date.parse('2027-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const { bangul } = app(t, { provider: provider(async () => reply()) });
  bangul.create(task({ schedule_type: 'at', schedule_value: '2027-01-01T00:01:00Z' }), 'once');
  bangul.create(
    task({ schedule_type: 'cron', schedule_value: '0 1 0 1 1 * 2027', time_zone: 'UTC' }),
    'finite',
  );
  now += 60001;
  for (const id of ['once', 'finite']) {
    assert.equal((await bangul.trigger(id, `run-${id}`)).status, 'success');
    assert.equal(bangul.get(id).nextRunAt, null);
    assert.equal(bangul.get(id).enabled, false);
  }
});

test('removing an active job cancels it and prevents external delivery', async (t) => {
  let started = false,
    delivered = 0;
  const { bangul } = app(t, {
    provider: provider(async () => {
      started = true;
      return new Promise(() => {});
    }),
    broadcast: {
      id: 'ui',
      version: '1',
      send() {
        delivered++;
      },
    },
  });
  bangul.create(task(), 'job');
  const pending = bangul.trigger('job', 'run');
  await waitFor(() => started);
  bangul.remove('job', 1);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(delivered, 0);
  assert.equal(bangul.get('job'), undefined);
});

test('a configured deadline ends an uncooperative model request and schedules bounded retry', async (t) => {
  const { bangul } = app(t, {
    provider: provider(() => new Promise(() => {})),
    settings: { job_timeout_secs: 1 },
  });
  bangul.create(task(), 'job');
  const started = Date.now(),
    run = await bangul.trigger('job', 'run');
  assert.equal(run.status, 'error');
  assert.equal(run.error, 'Execution deadline exceeded');
  assert.ok(Date.now() - started < 2500);
  assert.equal(bangul.get('job').consecutiveFailures, 1);
});
