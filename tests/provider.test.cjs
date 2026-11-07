// The published Gumiho wire adapter receives real local HTTP requests and preserves safe diagnostics.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('./runtime-helpers.cjs');
const { task } = require('./helpers.cjs');
const { ollamaChat } = require('../dist/library');

test('the public Ollama adapter sends text-only requests and records provider HTTP status without response secrets', async (t) => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    received.push({ path: request.url, body: JSON.parse(data) });
    response.setHeader('content-type', 'application/json');
    if (received.length > 1) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'SECRET_RESPONSE_BODY' }));
      return;
    }
    response.end(
      JSON.stringify({
        model: 'fixture',
        message: { role: 'assistant', content: 'Wire response 😀' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 2,
        eval_count: 3,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { bangul } = app(t, {
    provider: ollamaChat({
      id: 'local',
      model: 'fixture',
      retries: 0,
      endpoint: `http://127.0.0.1:${server.address().port}/api/chat`,
      contextLength: 2048,
      think: false,
    }),
  });
  bangul.create(task({ max_output_tokens: 128 }), 'job');
  const first = await bangul.trigger('job', 'first');
  assert.equal(first.status, 'success');
  assert.equal(first.content, 'Wire response 😀');
  assert.equal(first.usage.inputTokens, 2);
  assert.equal(received[0].path, '/api/chat');
  assert.deepEqual(received[0].body.tools, []);
  assert.equal(received[0].body.stream, false);
  assert.equal(received[0].body.options.num_ctx, 2048);
  assert.equal(received[0].body.options.num_predict, 128);
  const failed = await bangul.trigger('job', 'second');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Model provider request_failed (HTTP 401)');
  assert.doesNotMatch(JSON.stringify(bangul.history()), /SECRET_RESPONSE_BODY/);
});
