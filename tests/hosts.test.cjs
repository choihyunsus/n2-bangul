// Public metadata excludes host secrets while stateful provider, policy and delivery methods stay bound.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostRegistry } = require('../dist/hosts');
const { resolveJob, settingsInput } = require('../dist/config');
const { task } = require('./helpers.cjs');

test('class-based host capabilities retain private fields and only declared metadata enters a run snapshot', async () => {
  class Provider {
    #text = 'provider state';
    privateCredential = 'fixture-host-secret';
    get id() {
      return 'primary';
    }
    get version() {
      return 'v1';
    }
    get model() {
      return 'fixture';
    }
    get local() {
      return true;
    }
    async generate() {
      return this.#text;
    }
  }
  class Target {
    #text = 'target state';
    get id() {
      return 'notice';
    }
    get version() {
      return 'v1';
    }
    send() {
      return this.#text;
    }
  }
  class Policy {
    #allowed = true;
    id = 'policy-v1';
    check() {
      return { allowed: this.#allowed };
    }
  }
  const registry = new HostRegistry({
    provider: new Provider(),
    webhooks: [new Target()],
    policy: new Policy(),
  });
  assert.equal(await registry.providers.get('primary').generate(), 'provider state');
  assert.equal(registry.webhooks.get('notice').send(), 'target state');
  assert.equal(registry.policy.check().allowed, true);
  const job = resolveJob(task({ delivery: { webhook: 'notice' } })).definition;
  const snapshot = registry.snapshot(job, settingsInput.parse({}));
  assert.equal(snapshot.provider.id, 'primary');
  assert.equal(snapshot.deliveryVersions.webhook, 'v1');
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-host-secret|privateCredential/);
});

test('invalid host arrays, callbacks and reserved policy IDs fail explicitly', () => {
  for (const input of [
    { providers: 'invalid' },
    { providers: Array(17).fill({}) },
    { provider: null },
    { broadcast: false },
    { webhooks: Array(33).fill({}) },
    { policy: { id: 'allow-text-v1', check: () => ({ allowed: true }) } },
    { provider: { id: 'x', version: '1', model: ' ', local: true, generate: async () => ({}) } },
  ])
    assert.throws(() => new HostRegistry(input));
});
