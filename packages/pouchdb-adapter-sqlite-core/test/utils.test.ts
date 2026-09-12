import { describe, expect, it } from 'vitest';

import { handleSQLiteError } from '../src/utils';

describe('handleSQLiteError', () => {
  it('preserves the reason when a normalized SQLite error is handled again', () => {
    const first = handleSQLiteError(new Error('injected after document insert'));
    const second = handleSQLiteError(first);

    expect(second).toBe(first);
    expect(second).toMatchObject({
      status: 500,
      name: 'web_sql_went_bad',
      message: 'unknown',
      reason: 'injected after document insert',
    });
  });
});
