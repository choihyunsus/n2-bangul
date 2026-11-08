[Back to the getting-started guide](../README.md)

# N2 Bangul

Durable scheduled AI text tasks with shared Soul storage and independent delivery receipts.

[한국어 문서](reference.ko.md)

Bangul runs a text request at a specified time, at an interval, or according to a cron expression. A host supplies the model provider, policy and delivery destinations. The result, execution history and next schedule are committed together. Each delivery channel has a separate receipt and recovery procedure.

## Install

Node.js 22 or later is required. This version is distributed through GitHub Releases.

```sh
npm install https://github.com/choihyunsus/n2-bangul/releases/download/v1.0.0/n2-bangul-1.0.0.tgz
```

Gumiho 1.0.1 and Mimir 3.0.3 are pinned to their public GitHub archives. SQLite uses `better-sqlite3`. Mimir's compatible Rust binding is also supported. Some platforms require native build tools for SQLite.

## Library

```js
import { Bangul, ollamaChat } from 'n2-bangul';

const scheduler = new Bangul({
  dbPath: './data/mimir.db',
  project: 'personal-assistant',
  agent: 'scheduler',
  provider: ollamaChat({ id: 'local', model: process.env.N2_MODEL }),
});

try {
  const job = scheduler.create(
    {
      name: 'Daily planning prompt',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      time_zone: 'Asia/Seoul',
      user_message: 'Write one short question that helps someone plan their day.',
      max_output_tokens: 128,
    },
    'daily-note',
  );

  const result = await scheduler.trigger(job.id, 'manual-preview-001');
  console.log(result.status, result.content);
} finally {
  await scheduler.close();
}
```

The example makes one immediate manual request. Call `start()` to run the timer in a long-lived application, or use the CLI `run` command. A newly constructed instance keeps its timer stopped. Starting scheduling requires a registered provider.

Providers implement Gumiho's `ModelProvider` interface. The library reexports `openAIResponses`, `anthropicMessages`, `geminiInteractions`, `ollamaChat` and `openAICompatible`. `provider` selects the default provider. Additional `providers` are selected by a job's `provider_id`. Host credentials stay in provider closures or environment variables.

Scheduled requests have an empty tool list. `tools_json` accepts `null` or `[]`. Tool calls, incomplete responses and malformed text are recorded as errors. A complete empty text response is valid. Provider refusals and policy denials are recorded as `blocked`.

## Scheduling

| Setting                   | Meaning                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `at`                      | Future RFC3339 timestamp with an offset, or an unambiguous local date-time in `time_zone` |
| `every`                   | Interval of 1–31,536,000 seconds, measured from completion                                |
| `cron`                    | Croner 11 expression with 5, 6 or 7 fields, aliases and optional year                     |
| `time_zone`               | IANA zone, resolved and stored when the job is created                                    |
| `retry_max`               | Additional error retries, default 3, range 0–10                                           |
| `retry_backoff_base_secs` | Exponential backoff base, default 30, capped at 3,600 seconds                             |

Execution times are stored as UTC epoch milliseconds. A local `at` time in a daylight-saving gap or repeated hour requires an explicit offset. Croner handles cron transitions using its own rules. Fixed-time schedules select the first repeated occurrence and move a missing time to the first valid time that day. Interval patterns can select both repeated occurrences and skip missing ones.

Completed one-shot and exhausted finite cron schedules are disabled cleanly. Re-enabling an exhausted one-shot requires an updated future definition. Startup catch-up processes up to five missed jobs sequentially with a default five-second gap, then resumes normal polling. Each overdue job produces one request per dispatch.

`configure()` replaces the shared scheduler settings.

| Setting               | Default | Range    |
| --------------------- | ------- | -------- |
| `max_concurrent_jobs` | 3       | 1–8      |
| `tick_interval_secs`  | 15      | 1–3,600  |
| `job_timeout_secs`    | 300     | 1–3,600  |
| `catchup_stagger_ms`  | 5,000   | 0–60,000 |

Manual requests, catch-up and ordinary timer requests share the same scoped database capacity. Each job has one active or unresolved execution. Timer ownership is also scoped. The lease lasts 30 seconds, renews every 10 seconds and includes a process ID and nonce. This coordination assumes a local database shared by processes on one machine.

## API and recovery

| Method                                                     | Purpose                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `create(input, id?)`, `get(id)`, `list(limit?, offset?)`   | Register and inspect jobs                                           |
| `update(id, input, expectedRevision)`                      | Replace a definition using revision checking                        |
| `setEnabled(id, enabled)`, `remove(id, expectedRevision)`  | Control future dispatch or soft-delete a job                        |
| `trigger(jobId, runId?)`                                   | Await local execution and delivery attempts                         |
| `submit(jobId, runId?)`                                    | Return a durable acknowledgement for background work                |
| `start()`, `stop()`, `tick()`                              | Control the timer or dispatch currently due jobs                    |
| `history(limit?, offset?, jobId?)`, `getRun(id)`           | Inspect durable execution records                                   |
| `getDeliveries(id)`, `deliver(id)`                         | Inspect receipts and process pending delivery channels              |
| `recover()`, `reconcileRun(id, outcome, evidence)`         | Recover interrupted ownership and resolve an unknown result         |
| `resolveDelivery(id, channel, action, evidence)`           | Resolve a failed or unknown delivery with `retry`, `sent` or `skip` |
| `settings()`, `configure(settings)`, `status()`, `close()` | Configure and manage the instance                                   |

A stable job ID makes identical creation retries idempotent. A stable run ID retrieves the historical execution for that job and trigger kind. Use a new run ID for each new logical request, including after editing the job. Replaying a completed run returns its saved outcome. Pending delivery recovery is explicit through `deliver()`.

Opening an instance recovers expired or exited owners. An interrupted provider request becomes `unknown` and pauses its job. Inspect the external request before calling `reconcileRun()` with a recorded outcome and evidence. Repeated identical reconciliation returns the saved result. Re-enabling the job is a separate action.

An in-flight execution retains its original job, provider and policy snapshot. Its completion updates job scheduling only when the definition revision still matches. Pausing affects future automatic dispatch. Soft removal cancels an active request and suppresses pending delivery. `stop()` stops future timer dispatch and waits for any active catch-up request. `close()` cancels owned execution and awaits durable cleanup.

Deadlines propagate `AbortSignal` and discard late callback results. Uncooperative callbacks can continue in the host process. Applications that require forced termination should isolate those callbacks in owned worker processes. Failed provider requests may already have consumed provider tokens. Retry policy and provider billing should be considered together.

## Delivery and memory

Jobs select `delivery.log`, `delivery.broadcast` and an optional registered `delivery.webhook` ID. Log and broadcast default to enabled. An absent broadcast subscriber produces a skipped live notification. Requested webhooks must be registered before a model request starts.

The memory log inserts one scoped Mimir experience and its receipt in one transaction. Its JSON retains the request, response, provider, result hash and `verified: false`. Generated text is stored as an unverified model response. A failed log transaction can be retried independently.

Custom delivery targets have `{ id, version, send(event, context) }`. They receive a cancellation signal and a stable idempotency key. A host callback that fails to acknowledge completion leaves an `unknown` receipt. Inspect the receiver before resolving it. Receiver-side idempotency determines duplicate suppression across ambiguous network failures. Target versions are checked against the original execution snapshot.

`httpWebhook({ id, version, url, headers? })` registers a fixed HTTPS destination. Loopback HTTP is available for local integrations. The transport rejects URL credentials, fragments, redirects, header injection and overrides of managed headers. Destinations and authentication headers are operator-owned configuration. The host is responsible for endpoint trust and network access policy. Each external delivery attempt has a ten-second deadline.

## CLI and MCP

```sh
n2-bangul create --db ./data/mimir.db --project demo --agent scheduler --id daily-note < examples/daily-note.json
n2-bangul trigger --db ./data/mimir.db --project demo --agent scheduler --id daily-note --run-id preview-001 --adapter ./examples/ollama-host.cjs
n2-bangul run --db ./data/mimir.db --project demo --agent scheduler --adapter ./examples/ollama-host.cjs
n2-bangul mcp --db ./data/mimir.db --project demo --agent scheduler --adapter ./examples/ollama-host.cjs
```

The shell examples use stdin redirection. Configuration commands also accept `--input` JSON. Set `N2_MODEL` to an installed Ollama model before using the example adapter. An optional `N2_OLLAMA_URL` must be the complete API URL, including `/api/chat`. Local `.cjs`, `.mjs` and `.js` adapters export provider registrations, policy, delivery targets and optional settings. Loading one executes operator-selected JavaScript with host permissions.

Run `n2-bangul --help` for all commands. CLI `trigger` exits with 0 for success, 2 for a completed non-success result, and 1 for command or persistence errors. MCP exposes 16 tools for job CRUD, scheduling, bounded result reading and explicit recovery. MCP `bangul_trigger` acknowledges a background request. Its result is available through `bangul_history` and `bangul_read`. MCP initialization leaves the timer stopped until `bangul_start` is called.

## Soul storage and limits

Point `dbPath` to the SQLite file used by Soul and Mimir. Common memory tables retain Mimir 3.0.3's field contract. Module data uses `bangul_settings`, `bangul_jobs`, `bangul_history`, `bangul_deliveries` and `bangul_leases`, with `meta.bangul_schema_version = 1`. Every module row is owned by `project` and `agent`. Original unversioned Daebung Bangul tables require an explicit migration before using this package.

There are at most 1,024 current jobs per scope, 16 registered providers, 32 webhook destinations, 16 simultaneous delivery attempts and 16 locally retained execution tasks. Prompt, system prompt and result limits are 64, 32 and 128 KiB respectively. Text must be well-formed UTF-8. List/history pages contain at most 100 records. MCP responses are capped at 60,000 bytes and expose bounded text previews or result chunks.

History and full results persist until the operator archives them. `close()` releases active resources and keeps durable records available for restart. API credentials belong in host closures. Task prompts and model output are retained data.

## Verification and licensing

```sh
npm ci
npm test
npm run typecheck
npm audit --omit=dev
```

Tests exercise actual timers, CLI and stdio MCP, class-based callbacks, two-instance ownership, exited-child recovery, late transaction rollback, idempotent replay, webhook delivery, UTF-8 limits and DST transitions. CI runs source tests on Windows, Linux and macOS, builds one archive and tests that exact archive on all three systems, including strict TypeScript consumers.

Provider protocol tests use deterministic host adapters and local HTTP fixtures. A successful fixture run demonstrates the execution contract. Model quality, cloud credentials and destination availability require environment-specific verification.

Project source is MIT licensed. Mimir and transitive Clotho retain their published non-commercial/commercial terms. Review `LICENSE-N2-MIMIR`, `LICENSE-N2-CLOTHO`, `LICENSE-APACHE` and `THIRD-PARTY-NOTICES` when distributing an application with these dependencies.
