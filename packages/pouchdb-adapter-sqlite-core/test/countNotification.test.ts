import { describe, expect, it, vi } from 'vitest';
import sqliteBulkDocs from '../src/bulkDocs';
import type { TransactionalSQLiteDatabase } from '../src/interfaces';

describe('bulk notification completion', () => {
  it.each([false, true])('notifies only after successful commit (failure=%s)', async (fail) => {
    let commit!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const notify = vi.fn();
    const result = sqliteBulkDocs(
      {},
      { docs: [] },
      { new_edits: true },
      { _name: 'test' },
      async (callback) => {
        await callback({} as TransactionalSQLiteDatabase);
        entered();
        await barrier;
        if (fail) throw new Error('commit failed');
      },
      { notify }
    );
    const completed = result.then(
      () => true,
      () => false
    );
    await ready;
    expect(notify).not.toHaveBeenCalled();
    commit();
    expect(await completed).toBe(!fail);
    expect(notify).toHaveBeenCalledTimes(fail ? 0 : 1);
  });
});
