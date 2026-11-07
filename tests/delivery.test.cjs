// Delivery effects have their own durable receipts and recovery evidence, independent of generation.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, reply, provider } = require('./runtime-helpers.cjs');
const { task } = require('./helpers.cjs');
const { Bangul, httpWebhook } = require('../dist/library');

test('failed external acknowledgement requires evidence and retries delivery without another model call', async (t) => {
  let models = 0,
    sends = 0;
  const keys = [];
  const { bangul, store } = app(t, {
    provider: provider(async () => {
      models++;
      return reply();
    }),
    webhooks: [
      {
        id: 'destination',
        version: 'v1',
        send(event, context) {
          sends++;
          keys.push(context.idempotencyKey);
          assert.equal(event.content, '한글 result 😀');
          if (sends === 1) throw new Error('SECRET_WEBHOOK_TOKEN');
        },
      },
    ],
  });
  bangul.create(task({ delivery: { webhook: 'destination' } }), 'job');
  assert.equal((await bangul.trigger('job', 'run')).status, 'success');
  const receipt = () => bangul.getDeliveries('run').find((row) => row.channel === 'webhook');
  assert.equal(receipt().state, 'unknown');
  assert.doesNotMatch(JSON.stringify(receipt()), /SECRET_WEBHOOK_TOKEN/);
  await bangul.trigger('job', 'run');
  await bangul.deliver('run');
  assert.equal(sends, 1);
  assert.throws(() => bangul.resolveDelivery('run', 'webhook', 'retry', ''));
  bangul.resolveDelivery(
    'run',
    'webhook',
    'retry',
    'Receiver confirmed the idempotency key was not accepted',
  );
  await bangul.deliver('run');
  assert.equal(receipt().state, 'sent');
  assert.equal(models, 1);
  assert.equal(sends, 2);
  assert.equal(keys[0], keys[1]);
  bangul.resolveDelivery(
    'run',
    'webhook',
    'retry',
    'Receiver confirmed the idempotency key was not accepted',
  );
  await bangul.deliver('run');
  assert.equal(sends, 2);
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 1);
});

test('a failed memory receipt rolls back the inserted experience and can be delivered later', async (t) => {
  let models = 0;
  const { bangul, store } = app(t, {
    provider: provider(async () => {
      models++;
      return reply();
    }),
  });
  bangul.create(task(), 'job');
  store.db.execute(`CREATE TRIGGER reject_log_receipt BEFORE UPDATE ON bangul_deliveries
    WHEN NEW.channel='log' AND NEW.state='sent' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`);
  const result = await bangul.trigger('job', 'run');
  assert.equal(result.status, 'success');
  assert.equal(bangul.getDeliveries('run').find((row) => row.channel === 'log').state, 'failed');
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 0);
  store.db.execute('DROP TRIGGER reject_log_receipt');
  bangul.resolveDelivery('run', 'log', 'retry', 'Removed the injected failing transaction trigger');
  await bangul.deliver('run');
  assert.equal(store.db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 1);
  assert.equal(models, 1);
});

test('versioned delivery snapshots reject a changed host target and retain completed model history', async (t) => {
  let sends = 0;
  const setup = app(t, {
    provider: provider(async () => reply()),
    webhooks: [
      {
        id: 'destination',
        version: '1',
        send() {
          throw new Error('offline');
        },
      },
    ],
  });
  const { bangul, options, track } = setup;
  bangul.create(task({ delivery: { webhook: 'destination' } }), 'job');
  await bangul.trigger('job', 'run');
  await bangul.close();
  const replacement = track(
    new Bangul({
      ...options,
      webhooks: [
        {
          id: 'destination',
          version: '2',
          send() {
            sends++;
          },
        },
      ],
    }),
  );
  replacement.resolveDelivery(
    'run',
    'webhook',
    'retry',
    'Receiver inspection permits another attempt',
  );
  await replacement.deliver('run');
  assert.equal(sends, 0);
  assert.equal(
    replacement.getDeliveries('run').find((row) => row.channel === 'webhook').state,
    'failed',
  );
  assert.equal(replacement.getRun('run').status, 'success');
});

test('the HTTP target sends fixed JSON and an idempotency key and rejects redirects without following them', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/redirect') res.writeHead(302, { location: '/unapproved' });
    else res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = { signal: new AbortController().signal, idempotencyKey: 'fixture-key' };
  const event = {
    type: 'bangul_result',
    project: 'p',
    agent: 'a',
    run_id: 'r',
    job_id: 'j',
    job_name: 'name',
    content: 'hello',
    result_hash: 'a'.repeat(64),
    completed_at: 1,
  };
  await httpWebhook({
    id: 'fixture',
    version: '1',
    url: `${base}/receive`,
    headers: { authorization: 'fixture-only' },
  }).send(event, context);
  assert.equal(requests[0].headers['idempotency-key'], 'fixture-key');
  assert.deepEqual(JSON.parse(requests[0].body), event);
  await assert.rejects(
    httpWebhook({ id: 'redirect', version: '1', url: `${base}/redirect` }).send(event, context),
  );
  assert.deepEqual(
    requests.map((row) => row.path),
    ['/receive', '/redirect'],
  );
});

test('unsafe transport configuration fails before any delivery', () => {
  const options = { id: 'fixture', version: '1', url: 'https://example.com' };
  for (const url of [
    'http://example.com',
    'https://u:p@example.com',
    'https://example.com/#fragment',
    'https://example.com/\n',
  ])
    assert.throws(() => httpWebhook({ ...options, url }));
  for (const headers of [
    { host: 'override' },
    { 'content-length': '1' },
    { 'idempotency-key': 'override' },
    { authorization: 'secret\r\nInjected: header' },
  ])
    assert.throws(() => httpWebhook({ ...options, headers }));
});
