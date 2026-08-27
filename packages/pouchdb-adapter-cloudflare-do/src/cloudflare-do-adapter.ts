import type {
  OpenDatabaseOptions,
  SQLiteAdapter,
  SQLiteDatabase,
  SQLiteExecuteResult,
  SQLiteQueryResult,
} from 'pouchdb-adapter-sqlite-core/interface';

export type DurableObjectSqlValue = ArrayBuffer | string | number | null;

export interface DurableObjectSqlCursor<Row extends Record<string, DurableObjectSqlValue>> {
  readonly rowsWritten: number;
  toArray(): Row[];
}

export interface DurableObjectSqlStorage {
  exec<Row extends Record<string, DurableObjectSqlValue>>(
    query: string,
    ...bindings: unknown[]
  ): DurableObjectSqlCursor<Row>;
}

export interface DurableObjectStorageLike {
  readonly sql: DurableObjectSqlStorage;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface CloudflareDOOpenDatabaseOptions extends OpenDatabaseOptions {
  durableObjectStorage: DurableObjectStorageLike;
}

/**
 * Adapts the synchronous Durable Object SQL API to the promise-shaped core
 * adapter interface. Transactions remain owned by Durable Object storage.
 */
export class CloudflareDODatabase implements SQLiteAdapter {
  constructor(private readonly storage: DurableObjectStorageLike) {}

  async query(sql: string, params: unknown[] = []): Promise<SQLiteQueryResult> {
    return { values: this.storage.sql.exec(sql, ...params).toArray() };
  }

  async run(sql: string, params: unknown[] = []): Promise<SQLiteExecuteResult> {
    const cursor = this.storage.sql.exec(sql, ...params);
    const identity = this.storage.sql
      .exec<{ lastId: number }>('SELECT last_insert_rowid() AS lastId')
      .toArray()[0];

    return {
      changes: {
        changes: cursor.rowsWritten,
        lastId: identity?.lastId ?? 0,
      },
    };
  }

  async execute(sql: string): Promise<void> {
    this.storage.sql.exec(sql);
  }

  async transaction(fn: (db: SQLiteDatabase) => Promise<void>): Promise<void> {
    await this.storage.transaction(() => fn(this));
  }

  async beginTransaction(): Promise<void> {
    throw new Error('Durable Object SQL transactions must use storage.transaction(callback)');
  }

  async commitTransaction(): Promise<void> {
    throw new Error('Durable Object SQL transactions are committed by the storage callback');
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error('Durable Object SQL transactions are rolled back when the callback throws');
  }
}

export async function openCloudflareDODatabase(options: OpenDatabaseOptions) {
  const { durableObjectStorage } = options as CloudflareDOOpenDatabaseOptions;
  if (!durableObjectStorage?.sql || !durableObjectStorage.transaction) {
    return {
      error: new Error(
        'durableObjectStorage must be ctx.storage from a SQLite-backed Durable Object'
      ),
    };
  }

  return { db: new CloudflareDODatabase(durableObjectStorage) };
}
