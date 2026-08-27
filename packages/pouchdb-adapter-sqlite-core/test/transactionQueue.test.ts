import { describe, expect, it } from 'vitest';

import type { SQLiteAdapter, SQLiteDatabase } from '../src/interfaces';
import { LoggerSqliteAdapterWarpper } from '../src/LoggerAdapter';
import { TransactionQueue } from '../src/transactionQueue';

function legacyAdapter(events: string[]): SQLiteAdapter {
  return {
    async query() {
      return { values: [] };
    },
    async run() {
      return { changes: { changes: 0, lastId: 0 } };
    },
    async execute() {},
    async beginTransaction() {
      events.push('begin');
    },
    async commitTransaction() {
      events.push('commit');
    },
    async rollbackTransaction() {
      events.push('rollback');
    },
  };
}

describe('TransactionQueue', () => {
  it('retains explicit begin and commit transactions for legacy adapters', async () => {
    const events: string[] = [];
    const wrapped = new LoggerSqliteAdapterWarpper(legacyAdapter(events));
    const queue = new TransactionQueue(wrapped);

    expect(wrapped.transaction).toBeTypeOf('function');
    await queue.push(async (db) => {
      expect(db).toBe(wrapped);
      events.push('work');
    });

    expect(events).toEqual(['begin', 'work', 'commit']);
  });

  it('rolls back failed legacy transactions', async () => {
    const events: string[] = [];
    const wrapped = new LoggerSqliteAdapterWarpper(legacyAdapter(events));
    const queue = new TransactionQueue(wrapped);

    await expect(
      queue.push(async () => {
        events.push('work');
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');

    expect(events).toEqual(['begin', 'work', 'rollback']);
  });

  it('uses the database handle supplied by a callback transaction', async () => {
    const events: string[] = [];
    const scoped: SQLiteDatabase = {
      ...legacyAdapter(events),
      async query() {
        events.push('scoped-query');
        return { values: [{ source: 'scoped' }] };
      },
    };
    const outer: SQLiteAdapter = {
      ...legacyAdapter(events),
      async query() {
        throw new Error('outer handle used');
      },
      async transaction(fn) {
        events.push('native-begin');
        await fn(scoped);
        events.push('native-commit');
      },
    };

    const wrapped = new LoggerSqliteAdapterWarpper(outer);
    const queue = new TransactionQueue(wrapped);

    expect(wrapped.transaction).toBeTypeOf('function');
    await queue.push(async (db) => {
      const result = await db.query('SELECT 1');
      expect(result.values).toEqual([{ source: 'scoped' }]);
    });

    expect(events).toEqual(['native-begin', 'scoped-query', 'native-commit']);
  });
});
