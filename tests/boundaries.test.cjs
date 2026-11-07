// Corrupt stored definitions, filesystem destinations and reentrant shutdown fail at their boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { app, reply, provider, waitFor } = require('./runtime-helpers.cjs');
const { fixture, task } = require('./helpers.cjs');
const { BangulStore } = require('../dist/store');

test('a corrupt stored schedule fails before its provider can run even when its JSON digest matches', (t) => {
  let calls = 0;
  const { bangul, store } = app(t, {
    provider: provider(async () => {
      calls++;
      return reply();
    }),
  });
  const job = bangul.create(task(), 'job');
  const json = JSON.stringify({ ...job.definition, schedule_value: 'invalid-interval' });
  store.db.execute('UPDATE bangul_jobs SET definition_json=?,definition_hash=? WHERE id=?', [
    json,
    createHash('sha256').update(json).digest('hex'),
    'job',
  ]);
  assert.throws(() => bangul.submit('job', 'run'), /Invalid interval/);
  assert.equal(calls, 0);
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM bangul_history')[0].count, 0);
});

test('the database destination requires a durable regular file', (t) => {
  const { options, directory } = fixture(t);
  for (const dbPath of [':memory:', directory, '\\\\.\\NUL'])
    assert.throws(() => new BangulStore({ ...options, dbPath }), /regular|durable/);
});

test('reentrant close from a provider cancellation listener shares the original cleanup promise', async (t) => {
  let active = false,
    reentered;
  const { bangul } = app(t, {
    provider: provider(async (request) => {
      request.signal.addEventListener(
        'abort',
        () => {
          reentered = bangul.close();
        },
        { once: true },
      );
      active = true;
      return new Promise(() => {});
    }),
  });
  bangul.create(task(), 'job');
  const running = bangul.trigger('job', 'run');
  await waitFor(() => active);
  const first = bangul.close();
  assert.throws(() => bangul.create(task(), 'late'), /closing/);
  await first;
  assert.equal(reentered, first);
  assert.equal((await running).status, 'cancelled');
});
