// Bounded deterministic provider fixtures run through the same public entry points as applications.
const { fixture } = require('./helpers.cjs');
const { Bangul } = require('../dist/library');
const reply = (text = '한글 result 😀') => ({
  text,
  calls: [],
  stop: 'complete',
  model: 'fixture-model',
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
});
const provider = (generate) => ({
  id: 'fixture-model',
  version: '1',
  model: 'fixture-model',
  local: true,
  generate,
});
function app(t, extra = {}) {
  const setup = fixture(t);
  if (extra.settings) setup.store.configure(extra.settings);
  return { ...setup, bangul: setup.track(new Bangul({ ...setup.options, ...extra })) };
}
async function waitFor(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
module.exports = { app, reply, provider, waitFor };
