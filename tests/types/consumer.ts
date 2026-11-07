// Strict CJS and ESM consumers can configure providers and read durable scheduler records.
import { Bangul, httpWebhook, type ModelProvider, type JobInput, type RunRecord } from 'n2-bangul';
const provider: ModelProvider = {
  id: 'local',
  version: '1',
  model: 'fixture',
  local: true,
  async generate(request) {
    request.signal.throwIfAborted();
    return {
      text: 'result',
      calls: [],
      stop: 'complete',
      model: 'fixture',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
  },
};
const job: JobInput = {
  name: 'Daily note',
  schedule_type: 'cron',
  schedule_value: '0 9 * * *',
  time_zone: 'Asia/Seoul',
  user_message: 'Write a short note.',
};
const engine = new Bangul({
  dbPath: './consumer.db',
  project: 'consumer',
  agent: 'scheduler',
  provider,
  webhooks: [httpWebhook({ id: 'host', version: '1', url: 'https://example.com/hook' })],
});
const record = engine.create(job, 'job');
const revision: number = record.revision;
const result: Promise<RunRecord> = engine.trigger(record.id, 'run');
void [revision, result, engine.close()];
