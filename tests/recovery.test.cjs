// Late failures and interrupted ownership require explicit recovery without repeating an AI request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { app, reply, provider } = require('./runtime-helpers.cjs');
const { task } = require('./helpers.cjs');
const { Bangul } = require('../dist/library');
const { HostRegistry } = require('../dist/hosts');
const { beginRun } = require('../dist/runs');
const { completeRun } = require('../dist/completion');
const { beginDelivery } = require('../dist/delivery-store');

test('a process exiting after its durable start is paused as unknown and explicit reconciliation is idempotent', async (t) => {
  const { bangul, options, store } = app(t);
  bangul.create(task(), 'job');
  const code = `const {Bangul}=require('./dist/library'); const app=new Bangul({...JSON.parse(process.argv[1]),provider:{id:'p',version:'1',model:'m',local:true,async generate(){process.exit(37)}}}); app.submit('job','crashed');`;
  const child = spawnSync(process.execPath, ['-e', code, JSON.stringify(options)], {
    cwd: require('node:path').resolve(__dirname, '..'),
    timeout: 10000,
    encoding: 'utf8',
  });
  assert.equal(child.status, 37, child.stderr);
  assert.equal(bangul.recover(), 1);
  assert.equal(bangul.getRun('crashed').status, 'unknown');
  assert.equal(bangul.get('job').enabled, false);
  assert.throws(() => bangul.setEnabled('job', true), /unknown/);
  assert.throws(() => bangul.submit('job', 'new'), /unknown/);
  const outcome = { status: 'success', content: 'Recovered provider result', model: 'm' };
  const result = bangul.reconcileRun('crashed', outcome, 'Inspected the provider request receipt');
  assert.equal(result.status, 'success');
  assert.deepEqual(
    bangul.reconcileRun('crashed', outcome, 'Inspected the provider request receipt'),
    result,
  );
  assert.throws(() =>
    bangul.reconcileRun(
      'crashed',
      { ...outcome, content: 'different' },
      'Inspected the provider request receipt',
    ),
  );
  await bangul.deliver('crashed');
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 1);
  assert.equal(bangul.get('job').enabled, false);
  bangul.setEnabled('job', true);
});

test('a late completion transaction failure leaves start and schedule intact until evidence resolves it', async (t) => {
  let calls = 0;
  const { bangul, store } = app(t, {
    provider: provider(async () => {
      calls++;
      return reply();
    }),
  });
  const original = bangul.create(task(), 'job');
  store.db.execute(
    `CREATE TRIGGER reject_completion BEFORE INSERT ON bangul_deliveries BEGIN SELECT RAISE(ABORT,'fixture failure'); END`,
  );
  await assert.rejects(bangul.trigger('job', 'run'), /fixture failure/);
  assert.equal(bangul.getRun('run').status, 'running');
  assert.deepEqual(bangul.get('job'), original);
  store.db.execute('DROP TRIGGER reject_completion');
  bangul.recover();
  assert.equal(bangul.getRun('run').status, 'unknown');
  assert.equal((await bangul.trigger('job', 'run')).status, 'unknown');
  assert.equal(calls, 1);
});

test('a stale lease cannot finalize after another instance takes ownership', (t) => {
  const { bangul, store, options, track } = app(t);
  bangul.create(task(), 'job');
  const started = beginRun(store, new HostRegistry(options), 'job', 'run');
  store.db.execute("UPDATE bangul_leases SET expires_at=0 WHERE kind='job'");
  const other = track(new Bangul(options));
  assert.equal(other.getRun('run').status, 'unknown');
  assert.throws(
    () =>
      started.lease.mutate(() =>
        completeRun(store, started.run, { status: 'success', content: 'late' }),
      ),
    /expired|lost/,
  );
  started.lease.release();
});

test('interrupted atomic memory delivery is resumable while an external sending receipt stays unknown', async (t) => {
  const { bangul, store, options } = app(t);
  bangul.create(task({ delivery: { webhook: 'destination' } }), 'job');
  const started = beginRun(
    store,
    new HostRegistry({ ...options, webhooks: [{ id: 'destination', version: '1', send() {} }] }),
    'job',
    'run',
  );
  started.lease.mutate(() =>
    completeRun(store, started.run, { status: 'success', content: 'result' }),
  );
  started.lease.release();
  const log = beginDelivery(store, 'run', 'log'),
    webhook = beginDelivery(store, 'run', 'webhook');
  log.release();
  webhook.release();
  assert.equal(bangul.recover(), 2);
  const receipts = bangul.getDeliveries('run');
  assert.equal(receipts.find((row) => row.channel === 'log').state, 'pending');
  assert.equal(receipts.find((row) => row.channel === 'webhook').state, 'unknown');
  await bangul.deliver('run');
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 1);
});
