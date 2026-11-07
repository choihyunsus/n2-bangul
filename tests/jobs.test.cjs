// Job mutations retain current definitions, pause state and foreign owners across retries and restarts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, task } = require('./helpers.cjs');
const { BangulStore } = require('../dist/store');
const {
  createJob,
  getJob,
  updateJob,
  setEnabled,
  removeJob,
  listJobs,
  dueJobs,
} = require('../dist/jobs');

test('create, edit, pause and soft removal retain revisions and reject conflicting retries', (t) => {
  const { store } = fixture(t),
    input = task({ user_message: '한글 😀' });
  const first = createJob(store, input, 'job-one');
  assert.equal(first.revision, 1);
  assert.deepEqual(createJob(store, input, 'job-one'), first);
  input.user_message = 'changed outside';
  assert.equal(getJob(store, 'job-one').definition.user_message, '한글 😀');
  assert.throws(() => createJob(store, input, 'job-one'), /different/);
  setEnabled(store, 'job-one', false);
  const edited = updateJob(store, 'job-one', task({ name: 'Edited task' }), first.revision);
  assert.equal(edited.revision, 2);
  assert.equal(edited.enabled, false);
  assert.throws(() => updateJob(store, 'job-one', task(), 1), /revision/);
  removeJob(store, 'job-one', 2);
  removeJob(store, 'job-one', 2);
  assert.equal(getJob(store, 'job-one'), undefined);
  assert.equal(getJob(store, 'job-one', true).revision, 3);
  assert.deepEqual(listJobs(store), []);
  assert.throws(() => createJob(store, task(), 'job-one'), /deleted/);
});

test('retrying an existing one-shot registration after its scheduled time reuses the original job', (t) => {
  const { store } = fixture(t);
  let now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const input = task({
    schedule_type: 'at',
    schedule_value: '2026-01-02T00:00:00Z',
    time_zone: 'UTC',
  });
  const original = createJob(store, input, 'one-shot');
  now = Date.parse('2026-01-03T00:00:00Z');
  assert.deepEqual(createJob(store, input, 'one-shot'), original);
});

test('shared settings and jobs survive reopening while other scopes remain isolated', (t) => {
  const { store, open } = fixture(t);
  store.configure({ max_concurrent_jobs: 1 });
  const job = createJob(store, task(), 'job-one'),
    reopened = open({});
  assert.equal(reopened.settings().max_concurrent_jobs, 1);
  assert.deepEqual(getJob(reopened, job.id), job);
  const foreign = open({ agent: 'other' });
  assert.equal(getJob(foreign, job.id), undefined);
  assert.equal(foreign.settings().max_concurrent_jobs, 3);
  assert.equal(listJobs(foreign).length, 0);
  assert.throws(() => updateJob(foreign, job.id, task(), 1), /not found/);
});

test('due selection is bounded and excludes paused or deleted jobs', (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 4; i++) createJob(store, task(), `job-${i}`);
  store.db.execute('UPDATE bangul_jobs SET next_run_at=1');
  setEnabled(store, 'job-1', false);
  removeJob(store, 'job-2', 1);
  assert.deepEqual(dueJobs(store, 8), ['job-0', 'job-3']);
  assert.equal(dueJobs(store, 1).length, 1);
  assert.throws(() => dueJobs(store, 9));
  assert.throws(() => listJobs(store, 0));
});

test('failed edits roll back and damaged values remain available for explicit repair', (t) => {
  const { store } = fixture(t),
    job = createJob(store, task(), 'job-one');
  store.db.execute(
    "CREATE TRIGGER reject_edit BEFORE UPDATE ON bangul_jobs BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(() => updateJob(store, job.id, task({ name: 'changed' }), 1), /fixture failure/);
  assert.deepEqual(getJob(store, job.id), job);
  store.db.execute('DROP TRIGGER reject_edit');
  store.db.execute('UPDATE bangul_jobs SET last_error=?', ['x'.repeat(2049)]);
  assert.throws(() => getJob(store, job.id));
  assert.equal(store.db.query('SELECT last_error FROM bangul_jobs')[0].last_error.length, 2049);
});

test('future schemas and conflicting constructor settings fail before replacing stored configuration', (t) => {
  const { store, options } = fixture(t);
  assert.throws(() => new BangulStore(options, { max_concurrent_jobs: 1 }), /differ/);
  assert.equal(store.settings().max_concurrent_jobs, 3);
  store.db.execute("UPDATE meta SET value='2' WHERE key='bangul_schema_version'");
  assert.throws(() => new BangulStore(options), /Unsupported/);
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM bangul_settings')[0].count, 1);
});
