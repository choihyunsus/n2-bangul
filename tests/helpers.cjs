// Keep each test's durable scheduler database inside its verified temporary directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BangulStore } = require('../dist/store');

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bangul-test-'));
  const options = {
    dbPath: path.join(directory, 'mimir.db'),
    project: 'fixture',
    agent: 'scheduler',
    ...extra,
  };
  const store = new BangulStore(options),
    stores = [store];
  const open = (overrides) => {
    const next = new BangulStore({ ...options, ...overrides });
    stores.push(next);
    return next;
  };
  const resources = [];
  const track = (resource) => {
    resources.push(resource);
    return resource;
  };
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close();
    for (const item of stores) if (!item.memory.isClosed) item.close();
    const resolved = fs.realpathSync.native(directory),
      root = fs.realpathSync.native(os.tmpdir());
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('bangul-test-'))
      throw new Error('Fixture ownership changed');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, options, store, open, track };
}
const task = (overrides) => ({
  name: 'Scheduled fixture',
  schedule_type: 'every',
  schedule_value: '60',
  user_message: 'Return a short text',
  ...overrides,
});
module.exports = { fixture, task };
