// Scheduled requests expose no tools and only accept complete, bounded text responses.
import { z } from 'zod';
import type { ModelReply } from 'n2-gumiho';
import { ProviderError } from 'n2-gumiho';
import type { BangulStore } from './store';
import type { HostRegistry } from './hosts';
import type { RunRecord } from './types';
import { usageSchema } from './history';
import { outcomeSchema, type Outcome } from './completion';
import { deadline, DeadlineExceeded } from './deadline';
import { utf8, digest, encode } from './values';

export async function invokeText(
  store: BangulStore,
  hosts: HostRegistry,
  run: RunRecord,
  signal: AbortSignal,
): Promise<Outcome> {
  try {
    return await deadline(
      signal,
      run.snapshot.settings.job_timeout_secs * 1000,
      async (requestSignal) => {
        const allowed = await checkPolicy(store, hosts, run, requestSignal);
        if (!allowed.allowed)
          return outcomeSchema.parse({
            status: 'blocked',
            error: allowed.reason ?? 'Host policy blocked this execution',
          });
        return requestText(store, hosts, run, requestSignal);
      },
    );
  } catch (error) {
    if (signal.aborted)
      return outcomeSchema.parse({ status: 'cancelled', error: 'Execution was cancelled' });
    return outcomeSchema.parse({
      status: 'error',
      error: diagnostic(error),
    });
  }
}
function diagnostic(error: unknown): string {
  if (error instanceof DeadlineExceeded) return 'Execution deadline exceeded';
  const codes = [
    'circuit_open',
    'timeout',
    'transport_failed',
    'request_failed',
    'retry_later',
    'response_too_large_or_empty',
    'response_too_large',
    'invalid_response',
  ];
  if (error instanceof ProviderError && codes.includes(error.code)) {
    const status = error.status;
    const http =
      Number.isInteger(status) && status! >= 100 && status! <= 599 ? ` (HTTP ${status})` : '';
    return `Model provider ${error.code}${http}`;
  }
  return 'Provider or policy failed; inspect the host diagnostics';
}
async function requestText(
  store: BangulStore,
  hosts: HostRegistry,
  run: RunRecord,
  signal: AbortSignal,
): Promise<Outcome> {
  const provider = hosts.providers.get(run.snapshot.provider.id ?? '');
  if (
    !provider ||
    provider.version !== run.snapshot.provider.version ||
    provider.model !== run.snapshot.provider.model
  )
    return outcomeSchema.parse({
      status: 'error',
      error: 'Selected provider is unavailable or changed',
    });
  const target = run.snapshot.job.delivery.webhook;
  if (
    target &&
    (!hosts.webhooks.has(target) ||
      hosts.webhooks.get(target)!.version !== run.snapshot.deliveryVersions.webhook)
  )
    return outcomeSchema.parse({
      status: 'error',
      error: 'Selected webhook is unavailable or changed',
    });
  signal.throwIfAborted();
  const job = run.snapshot.job;
  const reply = await provider.generate({
    model: provider.model,
    system: job.system_prompt ?? '',
    messages: [{ role: 'user', content: job.user_message }],
    tools: [],
    maxOutputTokens: job.max_output_tokens,
    requestId: digest(encode([...store.scope, run.id])),
    signal,
  });
  signal.throwIfAborted();
  return replyOutcome(reply);
}
async function checkPolicy(
  store: BangulStore,
  hosts: HostRegistry,
  run: RunRecord,
  signal: AbortSignal,
) {
  if ((hosts.policy?.id ?? 'allow-text-v1') !== run.snapshot.policyId)
    throw new Error('Policy changed');
  if (!hosts.policy) return { allowed: true, reason: undefined };
  return z.strictObject({ allowed: z.boolean(), reason: utf8(2048).optional() }).parse(
    await hosts.policy.check(structuredClone(run.snapshot.job), {
      project: store.scope[0],
      agent: store.scope[1],
      runId: run.id,
      signal,
    }),
  );
}
function replyOutcome(reply: ModelReply): Outcome {
  if (!reply || !Array.isArray(reply.calls) || reply.calls.length)
    return outcomeSchema.parse({
      status: 'error',
      error: 'Scheduled jobs support text responses only',
    });
  if (reply.stop === 'refused')
    return outcomeSchema.parse({ status: 'blocked', error: 'Provider refused the request' });
  if (reply.stop !== 'complete')
    return outcomeSchema.parse({
      status: 'error',
      error: 'Provider did not complete a text response',
    });
  return outcomeSchema.parse({
    status: 'success',
    content: utf8(131072).parse(reply.text),
    model: utf8(256).parse(reply.model),
    usage: usageSchema.parse(reply.usage),
  });
}
