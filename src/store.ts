// Own a single synchronous Mimir transaction boundary for scheduler and shared-memory writes.
import fs from 'node:fs';
import path from 'node:path';
import { MimirDatabase } from 'n2-mimir/storage';
import { z } from 'zod';
import { identity, utf8, digest, encode, parseJson, hash } from './values';
import { settingsInput, type Settings, type SettingsInput } from './config';
import { initializeSchema } from './schema';
import type { StoreOptions } from './types';
import { textColumn } from './sql';
const SETTINGS_BYTES = 4096;

export type SqlConnection = MimirDatabase['reasoning']['connection'];
export class BangulStore {
  readonly memory: MimirDatabase;
  readonly db: SqlConnection;
  readonly scope: [string, string];
  readonly dbPath: string;
  constructor(options: StoreOptions, settings?: SettingsInput) {
    this.scope = [identity.parse(options.project), identity.parse(options.agent)];
    const config = settingsInput.parse(settings ?? {});
    this.dbPath = databaseFile(options.dbPath);
    this.memory = new MimirDatabase(this.dbPath);
    this.db = this.memory.reasoning.connection;
    try {
      initializeSchema(this.db);
      this.db.transaction(() => {
        const json = encode(config, SETTINGS_BYTES);
        this.db.execute('INSERT OR IGNORE INTO bangul_settings VALUES(?,?,?,?)', [
          ...this.scope,
          json,
          digest(json),
        ]);
        if (settings && encode(this.settings(), SETTINGS_BYTES) !== json)
          throw new Error(
            'Stored scheduler settings differ; use configure to update them explicitly',
          );
      });
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db.query<Record<string, unknown>>(
      `SELECT ${textColumn('config_json', SETTINGS_BYTES)},${textColumn('config_hash', 64)}
        FROM bangul_settings WHERE project=? AND agent=?`,
      this.scope,
    )[0];
    if (!row || digest(utf8(SETTINGS_BYTES).parse(row.config_json)) !== hash.parse(row.config_hash))
      throw new Error('Stored scheduler settings are missing or have an invalid digest');
    return settingsInput.parse(parseJson(row.config_json, SETTINGS_BYTES));
  }
  configure(value: SettingsInput): void {
    const json = encode(settingsInput.parse(value), SETTINGS_BYTES);
    this.db.transaction(() => {
      this.settings();
      this.db.execute(
        'UPDATE bangul_settings SET config_json=?,config_hash=? WHERE project=? AND agent=?',
        [json, digest(json), ...this.scope],
      );
    });
  }
  close(): void {
    this.memory.close();
  }
}
function databaseFile(input: string): string {
  const filename = utf8(8192).min(1).parse(input);
  if (filename === ':memory:' || /^\\\\[.?]\\/u.test(filename))
    throw new Error('Bangul requires a durable regular SQLite file');
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const canonical = path.join(
    fs.realpathSync.native(path.dirname(resolved)),
    path.basename(resolved),
  );
  try {
    if (!fs.statSync(canonical).isFile())
      throw new Error('Database path must refer to a regular file');
    return fs.realpathSync.native(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (
      process.platform === 'win32' &&
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(path.basename(canonical))
    )
      throw new Error('Database path uses a reserved device name');
    return canonical;
  }
}
export function pagination(limit: number, offset: number): void {
  z.int().min(1).max(100).parse(limit);
  z.int().min(0).max(100000).parse(offset);
}
