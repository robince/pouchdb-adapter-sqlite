import { describe, expect, it, vi } from 'vitest';
import {
  incrementDocumentCount,
  readDocumentCount,
  validateDocumentCount,
} from '../src/documentCount';
import type { TransactionalSQLiteDatabase } from '../src/interfaces';

describe('document count validation', () => {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])(
    'rejects %s',
    (value) => {
      expect(() => validateDocumentCount(value)).toThrow();
    }
  );
  it.each([NaN, undefined, null, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid delta %s before accessing SQLite',
    async (delta) => {
      const run = vi.fn();
      const query = vi.fn();
      const db = { run, query } as unknown as TransactionalSQLiteDatabase;
      await expect(incrementDocumentCount(db, delta as number)).rejects.toThrow(
        'Invalid document count delta'
      );
      expect(run).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  );
  it('accepts zero and the largest safe integer', () => {
    expect(validateDocumentCount(0)).toBe(0);
    expect(validateDocumentCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('skips zero deltas and rejects missing affected-row information', async () => {
    const db = { run: async () => ({}) } as unknown as TransactionalSQLiteDatabase;
    await incrementDocumentCount(db, 0);
    await expect(incrementDocumentCount(db, 1)).rejects.toThrow('exactly one');
  });
  it.each([[], [{ doc_count: 1 }, { doc_count: 1 }]])(
    'rejects invalid cardinality',
    async (rows) => {
      const db = {
        query: async () => ({ values: rows }),
      } as unknown as TransactionalSQLiteDatabase;
      await expect(readDocumentCount(db)).rejects.toThrow();
    }
  );
});
