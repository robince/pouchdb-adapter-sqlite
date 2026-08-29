import { describe, expect, it } from 'vitest';

import SqlPouch from '../src/core';
import type { OpenDatabaseOptions, SQLiteAdapter } from '../src/interfaces';
import { registerSQLiteImplementation } from '../src/openDatabase';

function adapter(): SQLiteAdapter {
  return {
    async query(sql) {
      if (sql.includes("HEX('a')")) {
        return { values: [{ hex: '61' }] };
      }
      return { values: [] };
    },
    async run() {
      return { changes: { changes: 1, lastId: 1 } };
    },
    async execute() {},
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
  };
}

describe('core database lifecycle', () => {
  it('releases its database lease when setup fails', async () => {
    const implementation = `setup-failure-${crypto.randomUUID()}`;
    const setupError = new Error('setup failed');
    let closes = 0;
    const db = adapter();
    db.query = async (sql) => {
      if (sql.includes("HEX('a')")) {
        return { values: [{ hex: '61' }] };
      }
      throw setupError;
    };
    registerSQLiteImplementation(implementation, {
      async openDatabase() {
        return {
          db,
          close: async () => {
            closes++;
          },
        };
      },
    });

    const api: Record<string, any> = { auto_compaction: false };
    const options: OpenDatabaseOptions = {
      adapter: 'sqlite',
      name: `setup-failure-${crypto.randomUUID()}`,
      sqliteImplementation: implementation,
    };
    const error = await new Promise<unknown>((resolve) => {
      SqlPouch.call(api, options, resolve);
    });

    expect(error).toMatchObject({
      name: 'web_sql_went_bad',
      reason: setupError.message,
    });
    expect(closes).toBe(1);
  });

  it('releases its database lease after destroy', async () => {
    const implementation = `destroy-${crypto.randomUUID()}`;
    let closes = 0;
    registerSQLiteImplementation(implementation, {
      async openDatabase() {
        return {
          db: adapter(),
          close: async () => {
            closes++;
          },
        };
      },
    });

    const api: Record<string, any> = { auto_compaction: false };
    const options: OpenDatabaseOptions = {
      adapter: 'sqlite',
      name: `destroy-${crypto.randomUUID()}`,
      sqliteImplementation: implementation,
    };

    await new Promise<void>((resolve, reject) => {
      SqlPouch.call(api, options, (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      api._destroy({}, (error: unknown) => (error ? reject(error) : resolve()));
    });

    expect(closes).toBe(1);
  });

  it('waits for queued work before closing the native handle', async () => {
    const implementation = `close-barrier-${crypto.randomUUID()}`;
    let closes = 0;
    let releaseSequenceQuery!: () => void;
    let markSequenceStarted!: () => void;
    const sequenceQuery = new Promise<void>((resolve) => {
      releaseSequenceQuery = resolve;
    });
    const sequenceStarted = new Promise<void>((resolve) => {
      markSequenceStarted = resolve;
    });
    const db = adapter();
    db.query = async (sql) => {
      if (sql.includes("HEX('a')")) {
        return { values: [{ hex: '61' }] };
      }
      if (sql.includes('sqlite_sequence')) {
        markSequenceStarted();
        await sequenceQuery;
      }
      return { values: [] };
    };

    registerSQLiteImplementation(implementation, {
      async openDatabase() {
        return {
          db,
          close: async () => {
            closes++;
          },
        };
      },
    });

    const api: Record<string, any> = { auto_compaction: false };
    const options: OpenDatabaseOptions = {
      adapter: 'sqlite',
      name: `close-barrier-${crypto.randomUUID()}`,
      sqliteImplementation: implementation,
    };
    await new Promise<void>((resolve, reject) => {
      SqlPouch.call(api, options, (error) => (error ? reject(error) : resolve()));
    });

    const info = new Promise<void>((resolve, reject) => {
      api._info((error: unknown) => (error ? reject(error) : resolve()));
    });
    await sequenceStarted;
    const close = new Promise<void>((resolve, reject) => {
      api._close((error: unknown) => (error ? reject(error) : resolve()));
    });

    expect(closes).toBe(0);
    releaseSequenceQuery();
    await Promise.all([info, close]);
    expect(closes).toBe(1);
  });
});
