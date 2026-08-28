import type {
  CallbackTransactionCapability,
  OpenConfig,
  OpenDatabaseOptions,
  SQLiteDatabaseConnection,
  TransactionalSQLiteDatabase,
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

export interface CloudflareDOPouchOptions extends OpenConfig {
  sqliteImplementation: 'cloudflare-do';
  durableObjectStorage: DurableObjectStorageLike;
}

/** Create constructor options without weakening PouchDB configuration typing. */
export function cloudflareDOOptions(
  durableObjectStorage: DurableObjectStorageLike
): CloudflareDOPouchOptions {
  return {
    adapter: 'sqlite',
    sqliteImplementation: 'cloudflare-do',
    durableObjectStorage,
  };
}

/**
 * Adapts the synchronous Durable Object SQL API to the promise-shaped core
 * adapter interface. Transactions remain owned by Durable Object storage.
 */
export class CloudflareDODatabase
  implements SQLiteDatabaseConnection, CallbackTransactionCapability
{
  constructor(private readonly storage: DurableObjectStorageLike) {}

  async query(sql: string, params: unknown[] = []): Promise<SQLiteQueryResult> {
    return { values: this.storage.sql.exec(sql, ...params).toArray() };
  }

  async run(sql: string, params: unknown[] = []): Promise<SQLiteExecuteResult> {
    this.storage.sql.exec(sql, ...params);
    const result = this.storage.sql
      .exec<{
        changes: number;
        lastId: number;
      }>('SELECT changes() AS changes, last_insert_rowid() AS lastId')
      .toArray()[0];

    return {
      changes: {
        changes: result?.changes ?? 0,
        lastId: result?.lastId ?? 0,
      },
    };
  }

  async execute(sql: string): Promise<void> {
    this.storage.sql.exec(sql);
  }

  async transaction(fn: (db: TransactionalSQLiteDatabase) => Promise<void>): Promise<void> {
    await this.storage.transaction(() => fn(this));
  }
}

export async function openCloudflareDODatabase(options: OpenDatabaseOptions) {
  const { durableObjectStorage } = options as CloudflareDOOpenDatabaseOptions;
  if (
    typeof durableObjectStorage?.sql?.exec !== 'function' ||
    typeof durableObjectStorage.transaction !== 'function'
  ) {
    return {
      error: new Error(
        'durableObjectStorage must be ctx.storage from a SQLite-backed Durable Object'
      ),
    };
  }

  return { db: new CloudflareDODatabase(durableObjectStorage), close: async () => undefined };
}
