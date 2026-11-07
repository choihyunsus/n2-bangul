// Operators register fixed HTTPS destinations; scheduled text cannot select or redirect a target.
import { z } from 'zod';
import type { DeliveryTarget, DeliveryEvent, DeliveryContext } from './types';
import { identity, utf8, encode } from './values';
import { deadline } from './deadline';

export interface HttpWebhookOptions {
  id: string;
  version: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}
export function httpWebhook(options: HttpWebhookOptions): DeliveryTarget {
  const id = identity.parse(options.id),
    version = identity.parse(options.version);
  const destination = checkedUrl(options.url),
    headers = checkedHeaders(options.headers ?? {});
  return Object.freeze({
    id,
    version,
    async send(event: Readonly<DeliveryEvent>, context: DeliveryContext) {
      const body = encode(event, 1048576);
      await deadline(context.signal, 10000, async (signal) => {
        const response = await fetch(destination, {
          method: 'POST',
          body,
          redirect: 'error',
          signal,
          headers: {
            ...headers,
            'content-type': 'application/json',
            'idempotency-key': context.idempotencyKey,
          },
        });
        try {
          if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        } finally {
          await response.body?.cancel();
        }
      });
    },
  });
}
function checkedUrl(value: string): string {
  const text = utf8(8192)
    .refine((item) => !/[\s\p{Cc}]/u.test(item), 'Invalid webhook URL')
    .parse(value);
  const url = new URL(text);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Webhook requires HTTPS or a loopback HTTP fixture');
  if (url.username || url.password || url.hash)
    throw new Error('Webhook URL contains credentials or a fragment');
  return url.href;
}
function checkedHeaders(value: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(z.record(z.string(), z.string()).parse(value));
  if (entries.length > 32) throw new Error('Too many webhook headers');
  const headers: Record<string, string> = Object.create(null);
  for (const [name, text] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name))
      throw new Error('Invalid webhook header name');
    if (
      /^(host|content-length|content-type|idempotency-key|connection|transfer-encoding|upgrade)$/i.test(
        name,
      )
    )
      throw new Error('Webhook header is managed by the transport');
    headers[name] = utf8(8192)
      .refine((item) => !/[\r\n\p{Cc}]/u.test(item), 'Invalid webhook header value')
      .parse(text);
  }
  return headers;
}
