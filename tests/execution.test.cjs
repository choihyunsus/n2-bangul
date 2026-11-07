// Exercise the public scheduler with durable records, live callbacks, failures and cancellation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { task } = require('./helpers.cjs');
const { app, reply, provider, waitFor } = require('./runtime-helpers.cjs');
const { Bangul, Busy } = require('../dist/library');
const { getRun } = require('../dist/history');

test('public trigger commits its request before generation and atomically logs one result across replay', async (t) => {
  let count = 0,
    setup;
  setup = app(t, {
    provider: provider(async (request) => {
      count++;
      assert.equal(getRun(setup.store, 'run-1').status, 'running');
      assert.deepEqual(request.tools, []);
      assert.equal(request.messages[0].content, 'Return a short text');
      return reply();
    }),
  });
  const { bangul, store, options, track } = setup;
  bangul.create(task(), 'job');
  const result = await bangul.trigger('job', 'run-1');
  assert.equal(result.status, 'success');
  assert.equal(result.content, '한글 result 😀');
  assert.equal(bangul.getDeliveries('run-1').find((row) => row.channel === 'log').state, 'sent');
  assert.equal(store.db.query('SELECT * FROM experiences').length, 1);
  const memory = JSON.parse(store.db.query('SELECT context FROM experiences')[0].context);
  assert.equal(memory.verified, false);
  assert.equal(memory.response, result.content);
  assert.deepEqual(await bangul.trigger('job', 'run-1'), result);
  await bangul.close();
  const reopened = track(
    new Bangul({
      ...options,
      provider: provider(async () => {
        throw new Error('Must not regenerate');
      }),
    }),
  );
  assert.deepEqual(await reopened.trigger('job', 'run-1'), result);
  assert.equal(count, 1);
});

test('provider errors back off, stop at the retry budget and never leak exception details into records', async (t) => {
  const { bangul } = app(t, {
    provider: provider(async () => {
      throw new Error('SECRET_TOKEN_SENTINEL');
    }),
  });
  bangul.create(task({ retry_max: 1, retry_backoff_base_secs: 1 }), 'job');
  assert.equal((await bangul.trigger('job', 'first')).status, 'error');
  const first = bangul.get('job');
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.enabled, true);
  assert.ok(first.nextRunAt >= Date.now());
  await bangul.trigger('job', 'second');
  assert.equal(bangul.get('job').enabled, false);
  assert.equal(bangul.get('job').consecutiveFailures, 2);
  assert.equal(bangul.get('job').nextRunAt, null);
  assert.doesNotMatch(JSON.stringify(bangul.history()), /SECRET_TOKEN_SENTINEL/);
});

test('text-only response validation rejects tools, truncation and malformed text while preserving empty output', async (t) => {
  const replies = [
    { ...reply(), calls: [{ id: 'bad', name: 'file_write', arguments: {} }] },
    { ...reply(), stop: 'incomplete' },
    reply('\ud800'),
    reply(''),
    { ...reply(), stop: 'refused' },
  ];
  const { bangul } = app(t, { provider: provider(async () => replies.shift()) });
  bangul.create(task(), 'job');
  for (const [index, status] of ['error', 'error', 'error', 'success', 'blocked'].entries())
    assert.equal((await bangul.trigger('job', `run-${index}`)).status, status);
  assert.equal(bangul.getRun('run-3').content, '');
});

test('policy denial and unresolved registered targets prevent a model call', async (t) => {
  let calls = 0;
  const { bangul, options, track } = app(t, {
    provider: provider(async () => {
      calls++;
      return reply();
    }),
    policy: { id: 'deny-v1', check: () => ({ allowed: false, reason: 'fixture policy' }) },
  });
  bangul.create(task(), 'blocked');
  assert.equal((await bangul.trigger('blocked', 'denied')).status, 'blocked');
  const other = track(
    new Bangul({
      ...options,
      provider: provider(async () => {
        calls++;
        return reply();
      }),
    }),
  );
  other.create(task({ delivery: { webhook: 'missing' } }), 'webhook');
  assert.equal((await other.trigger('webhook', 'missing')).status, 'error');
  assert.equal(calls, 0);
});

test('manual and scheduled entry points share capacity across instances and active work survives opening another instance', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { bangul, options, track } = app(t, {
    settings: { max_concurrent_jobs: 1 },
    provider: provider(() => pending),
  });
  bangul.create(task(), 'first');
  bangul.create(task(), 'second');
  const running = bangul.trigger('first', 'run');
  const other = track(new Bangul({ ...options, provider: provider(async () => reply()) }));
  assert.equal(other.getRun('run').status, 'running');
  assert.throws(() => other.submit('second', 'other'), Busy);
  assert.throws(() => other.submit('first', 'duplicate'), Busy);
  release(reply());
  assert.equal((await running).status, 'success');
  assert.equal((await other.trigger('second', 'after')).status, 'success');
});

test('an in-flight edit preserves new scheduling while finishing the immutable original request', async (t) => {
  let release;
  const { bangul } = app(t, {
    provider: provider(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  });
  bangul.create(task(), 'job');
  const pending = bangul.trigger('job', 'run');
  await waitFor(() => release);
  const edited = bangul.update('job', task({ name: 'Edited', schedule_value: '300' }), 1);
  release(reply('old result'));
  const result = await pending;
  assert.equal(result.snapshot.job.name, 'Scheduled fixture');
  assert.deepEqual(bangul.get('job'), edited);
});

test('shutdown bounds an uncooperative request and persists cancellation without a late result', async (t) => {
  let release;
  const { bangul, store } = app(t, {
    provider: provider(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  });
  bangul.create(task(), 'job');
  const pending = bangul.trigger('job', 'run');
  await waitFor(() => release);
  const before = Date.now();
  await bangul.close();
  assert.ok(Date.now() - before < 1000);
  assert.equal((await pending).status, 'cancelled');
  release(reply('too late'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getRun(store, 'run').content, null);
});
