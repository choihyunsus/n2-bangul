// Scope scheduler state beside the common Soul schema and reject incompatible preexisting tables.
import type { SqlConnection } from './store';

export function initializeSchema(db: SqlConnection): void {
  db.transaction(() => {
    const version = db.query<{ value: unknown }>(
      "SELECT value FROM meta WHERE key='bangul_schema_version'",
    )[0]?.value;
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'bangul_*'",
    );
    if (version !== undefined && version !== '1')
      throw new Error('Unsupported Bangul schema version');
    if (tables.length && version === undefined)
      throw new Error('Unversioned Bangul tables require an explicit migration');
    for (const table of tables) {
      const columns = db.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
        table.name,
      ]);
      if (COLUMNS[table.name]?.join(',') !== columns.map((column) => column.name).join(','))
        throw new Error('Existing Bangul tables have an incompatible schema');
    }
    for (const sql of STATEMENTS) db.execute(sql);
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('bangul_schema_version','1')");
  });
}
const COLUMNS: Record<string, string[]> = {
  bangul_settings: ['project', 'agent', 'config_json', 'config_hash'],
  bangul_jobs: [
    'project',
    'agent',
    'id',
    'definition_json',
    'definition_hash',
    'revision',
    'enabled',
    'consecutive_failures',
    'next_run_at',
    'last_run_at',
    'last_result',
    'last_error',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  bangul_history: [
    'project',
    'agent',
    'id',
    'job_id',
    'job_revision',
    'input_json',
    'input_hash',
    'trigger_kind',
    'retry_attempt',
    'scheduled_at',
    'started_at',
    'finished_at',
    'status',
    'result_content',
    'result_hash',
    'response_model',
    'usage_json',
    'error_message',
    'reconciliation',
  ],
  bangul_deliveries: [
    'project',
    'agent',
    'run_id',
    'channel',
    'version',
    'state',
    'attempts',
    'receipt_id',
    'error_message',
    'started_at',
    'finished_at',
    'reconciliation',
  ],
  bangul_leases: [
    'project',
    'agent',
    'kind',
    'subject_id',
    'run_id',
    'nonce',
    'process_id',
    'expires_at',
  ],
};
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bangul_settings (
    project TEXT NOT NULL,agent TEXT NOT NULL,config_json TEXT NOT NULL,config_hash TEXT NOT NULL,
    PRIMARY KEY(project,agent))`,
  `CREATE TABLE IF NOT EXISTS bangul_jobs (
    project TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,
    definition_json TEXT NOT NULL CHECK(length(CAST(definition_json AS BLOB))<=262144),definition_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),consecutive_failures INTEGER NOT NULL,
    next_run_at INTEGER,last_run_at INTEGER,last_result TEXT,last_error TEXT,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,
    PRIMARY KEY(project,agent,id))`,
  `CREATE INDEX IF NOT EXISTS idx_bangul_due ON bangul_jobs(project,agent,enabled,next_run_at,id) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS bangul_history (
    project TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,job_id TEXT NOT NULL,job_revision INTEGER NOT NULL,
    input_json TEXT NOT NULL CHECK(length(CAST(input_json AS BLOB))<=524288),input_hash TEXT NOT NULL,
    trigger_kind TEXT NOT NULL CHECK(trigger_kind IN('manual','scheduled')),retry_attempt INTEGER NOT NULL,
    scheduled_at INTEGER,started_at INTEGER NOT NULL,finished_at INTEGER,
    status TEXT NOT NULL CHECK(status IN('running','success','error','blocked','cancelled','unknown')),
    result_content TEXT,result_hash TEXT,response_model TEXT,usage_json TEXT,error_message TEXT,reconciliation TEXT,
    PRIMARY KEY(project,agent,id),FOREIGN KEY(project,agent,job_id) REFERENCES bangul_jobs(project,agent,id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bangul_pending ON bangul_history(project,agent,job_id) WHERE status IN('running','unknown')`,
  `CREATE INDEX IF NOT EXISTS idx_bangul_history ON bangul_history(project,agent,started_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS bangul_deliveries (
    project TEXT NOT NULL,agent TEXT NOT NULL,run_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN('log','broadcast','webhook')),version TEXT,
    state TEXT NOT NULL CHECK(state IN('pending','sending','sent','failed','unknown','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,receipt_id TEXT,error_message TEXT,started_at INTEGER,finished_at INTEGER,reconciliation TEXT,
    PRIMARY KEY(project,agent,run_id,channel),FOREIGN KEY(project,agent,run_id) REFERENCES bangul_history(project,agent,id))`,
  `CREATE TABLE IF NOT EXISTS bangul_leases (
    project TEXT NOT NULL,agent TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('scheduler','job','delivery')),
    subject_id TEXT NOT NULL,run_id TEXT,nonce TEXT NOT NULL,process_id INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    PRIMARY KEY(project,agent,kind,subject_id))`,
  `CREATE INDEX IF NOT EXISTS idx_bangul_delivery_state ON bangul_deliveries(project,agent,state,run_id,channel)`,
  `CREATE INDEX IF NOT EXISTS idx_bangul_history_state ON bangul_history(project,agent,status,started_at,id)`,
];
