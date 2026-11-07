// Executable and stdio entry points exercise persisted scheduling through real child processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, task } = require('./helpers.cjs');
const { waitFor } = require('./runtime-helpers.cjs');
const entry = path.resolve(__dirname, '../dist/index.js');
const adapterSource = `{provider:{id:'fixture',version:'1',model:'fixture',local:true,async generate(request){
  if(request.tools.length)throw new Error('Unexpected tools');
  return {text:'Result 😀 '+request.messages[0].content,calls:[],stop:'complete',model:'fixture',usage:{inputTokens:1,outputTokens:1,cachedInputTokens:0}};
}}}`;
const scopeArgs = (options) => [
  '--db',
  options.dbPath,
  '--project',
  options.project,
  '--agent',
  options.agent,
];
const command = (options, args, input) =>
  spawnSync(process.execPath, [entry, ...args, ...scopeArgs(options)], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
function adapter(directory, extension) {
  const filename = path.join(directory, `adapter.${extension}`);
  fs.writeFileSync(
    filename,
    `${extension === 'cjs' ? 'module.exports=' : 'export default '}${adapterSource};\n`,
  );
  return filename;
}

test('CLI CRUD, both adapter formats, trigger replay and result inspection share one durable scope', (t) => {
  const { options, directory } = fixture(t);
  const run = (args, input) => {
    const output = command(options, args, input);
    assert.equal(output.status, 0, output.stderr);
    return JSON.parse(output.stdout);
  };
  assert.equal(run(['create', '--id', 'job'], JSON.stringify(task())).revision, 1);
  assert.equal(run(['pause', '--id', 'job']).enabled, false);
  assert.equal(run(['enable', '--id', 'job']).enabled, true);
  assert.equal(
    run(['update', '--id', 'job', '--revision', '1'], JSON.stringify(task({ name: 'edited' })))
      .revision,
    2,
  );
  assert.equal(run(['get', '--id', 'job']).definition.name, 'edited');
  assert.equal(run(['list', '--limit', '1']).length, 1);
  for (const extension of ['cjs', 'mjs']) {
    const result = run([
      'trigger',
      '--id',
      'job',
      '--run-id',
      `run-${extension}`,
      '--adapter',
      adapter(directory, extension),
    ]);
    assert.equal(result.status, 'success');
    assert.match(result.content, /^Result 😀/);
  }
  assert.equal(run(['trigger', '--id', 'job', '--run-id', 'run-cjs']).status, 'success');
  assert.equal(run(['history', '--id', 'job']).length, 2);
  assert.equal(run(['read', '--id', 'run-cjs']).run.status, 'success');
  assert.ok(run(['deliver', '--id', 'run-cjs']).some((row) => row.state === 'sent'));
  assert.equal(run(['remove', '--id', 'job', '--revision', '2']).removed, 'job');
  assert.equal(run(['get', '--id', 'job']), null);
});

test('CLI rejects malformed input and contradictory flags before scheduling', (t) => {
  const { options } = fixture(t);
  for (const args of [
    ['status', '--id', 'invalid'],
    ['status', '--input', '{}'],
    ['status', '--unknown'],
    ['list', '--limit', '0'],
    ['get'],
    ['remove', '--id', 'job'],
    ['status', '--project', 'duplicate'],
    ['run'],
  ]) {
    const result = command(options, args);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(JSON.parse(result.stderr).error);
  }
  assert.equal(command(options, ['create'], Buffer.from([0xff])).status, 1);
  assert.equal(command(options, ['create'], 'x'.repeat(524289)).status, 1);
  const version = spawnSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '1.0.0');
});

test('actual stdio MCP submits a job, reads a completed result and exposes sixteen scoped tools', async (t) => {
  const { options, directory, store } = fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'mcp', ...scopeArgs(options), '--adapter', adapter(directory, 'cjs')],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'bangul-test', version: '1' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(Buffer.byteLength(result.content[0].text) <= 60000);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 16);
    await call('bangul_configure', { settings: { tick_interval_secs: 1, catchup_stagger_ms: 0 } });
    await call('bangul_create', { id: 'job', job: task() });
    assert.equal(
      (await call('bangul_get', { id: 'job' })).definition.user_message.text,
      task().user_message,
    );
    assert.equal((await call('bangul_trigger', { id: 'job', runId: 'run' })).runId, 'run');
    await waitFor(
      () =>
        store.db.query("SELECT 1 FROM bangul_history WHERE id='run' AND status='success'").length >
        0,
    );
    const result = await call('bangul_read', { id: 'run', limit: 8 });
    assert.equal(result.content, 'Result 😀');
    assert.equal(result.hasMore, true);
    assert.equal((await call('bangul_history')).length, 1);
    await call('bangul_enable', { id: 'job', enabled: false });
    await call('bangul_start');
    await call('bangul_stop');
    assert.equal((await call('bangul_status')).state, 'stopped');
    assert.equal(stderr, '');
  } finally {
    await client.close();
  }
});
