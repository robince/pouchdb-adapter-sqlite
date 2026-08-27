const assert = require('node:assert/strict');
const { test } = require('node:test');

const { LoggerSqliteAdapterWarpper } = require('../.test-lib-cjs/LoggerAdapter.js');
const { TransactionQueue } = require('../.test-lib-cjs/transactionQueue.js');

function legacyAdapter(events) {
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

test('legacy adapters retain explicit begin and commit transactions', async () => {
  const events = [];
  const wrapped = new LoggerSqliteAdapterWarpper(legacyAdapter(events));
  const queue = new TransactionQueue(wrapped);

  assert.equal(wrapped.transaction, undefined);
  await queue.push(async (db) => {
    assert.equal(db, wrapped);
    events.push('work');
  });

  assert.deepEqual(events, ['begin', 'work', 'commit']);
});

test('legacy adapters roll back failed transactions', async () => {
  const events = [];
  const wrapped = new LoggerSqliteAdapterWarpper(legacyAdapter(events));
  const queue = new TransactionQueue(wrapped);

  await assert.rejects(
    queue.push(async () => {
      events.push('work');
      throw new Error('failed');
    }),
    /failed/
  );

  assert.deepEqual(events, ['begin', 'work', 'rollback']);
});

test('callback transactions use the scoped database handle', async () => {
  const events = [];
  const scoped = legacyAdapter(events);
  scoped.query = async () => {
    events.push('scoped-query');
    return { values: [{ source: 'scoped' }] };
  };

  const outer = legacyAdapter(events);
  outer.query = async () => {
    throw new Error('outer handle used');
  };
  outer.transaction = async (fn) => {
    events.push('native-begin');
    await fn(scoped);
    events.push('native-commit');
  };

  const wrapped = new LoggerSqliteAdapterWarpper(outer);
  const queue = new TransactionQueue(wrapped);

  assert.equal(typeof wrapped.transaction, 'function');
  await queue.push(async (db) => {
    const result = await db.query('SELECT 1');
    assert.deepEqual(result.values, [{ source: 'scoped' }]);
  });

  assert.deepEqual(events, ['native-begin', 'scoped-query', 'native-commit']);
});
