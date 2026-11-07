// Capture public provider metadata while retaining credentials and stateful callbacks in host closures.
import type { ModelProvider } from 'n2-gumiho';
import type { BangulOptions, DeliveryTarget, RunPolicy, RunSnapshot } from './types';
import type { JobDefinition, Settings } from './config';
import { identity, line } from './values';

export class HostRegistry {
  readonly providers = new Map<string, Readonly<ModelProvider>>();
  readonly webhooks = new Map<string, Readonly<DeliveryTarget>>();
  readonly defaultProvider: string | null;
  readonly broadcast?: Readonly<DeliveryTarget>;
  readonly policy?: Readonly<RunPolicy>;
  constructor(options: BangulOptions) {
    const additional = options.providers ?? [],
      targets = options.webhooks ?? [];
    if (
      !Array.isArray(additional) ||
      additional.length > 16 ||
      !Array.isArray(targets) ||
      targets.length > 32
    )
      throw new Error('Host registration exceeds its limit');
    const providers =
      options.provider === undefined ? additional : [options.provider, ...additional];
    if (providers.length > 16) throw new Error('Host registration exceeds its limit');
    for (const item of providers) {
      const provider = checkedProvider(item);
      if (this.providers.has(provider.id)) throw new Error('Duplicate provider ID');
      this.providers.set(provider.id, provider);
    }
    for (const item of targets) {
      const target = checkedTarget(item);
      if (this.webhooks.has(target.id)) throw new Error('Duplicate webhook ID');
      this.webhooks.set(target.id, target);
    }
    this.defaultProvider =
      options.provider === undefined ? null : (this.providers.keys().next().value ?? null);
    this.broadcast = options.broadcast === undefined ? undefined : checkedTarget(options.broadcast);
    if (options.policy !== undefined) {
      if (!options.policy) throw new Error('Invalid policy');
      const id = identity.parse(options.policy.id);
      if (id === 'allow-text-v1' || typeof options.policy.check !== 'function')
        throw new Error('Invalid or reserved policy');
      this.policy = Object.freeze({ id, check: options.policy.check.bind(options.policy) });
    }
  }
  snapshot(job: JobDefinition, settings: Settings): RunSnapshot {
    const id = job.provider_id ?? this.defaultProvider,
      provider = id ? this.providers.get(id) : undefined;
    return {
      job,
      settings,
      provider: { id, version: provider?.version ?? null, model: provider?.model ?? null },
      policyId: this.policy?.id ?? 'allow-text-v1',
      deliveryVersions: {
        broadcast: job.delivery.broadcast ? (this.broadcast?.version ?? null) : null,
        webhook: job.delivery.webhook
          ? (this.webhooks.get(job.delivery.webhook)?.version ?? null)
          : null,
      },
    };
  }
}
function checkedProvider(value: ModelProvider): Readonly<ModelProvider> {
  if (!value || typeof value.generate !== 'function' || typeof value.local !== 'boolean')
    throw new Error('Invalid provider');
  const id = identity.parse(value.id),
    version = identity.parse(value.version),
    model = line(256).parse(value.model);
  return Object.freeze({
    id,
    version,
    model,
    local: value.local,
    generate: value.generate.bind(value),
  });
}
function checkedTarget(value: DeliveryTarget): Readonly<DeliveryTarget> {
  if (!value || typeof value.send !== 'function') throw new Error('Invalid delivery target');
  return Object.freeze({
    id: identity.parse(value.id),
    version: identity.parse(value.version),
    send: value.send.bind(value),
  });
}
