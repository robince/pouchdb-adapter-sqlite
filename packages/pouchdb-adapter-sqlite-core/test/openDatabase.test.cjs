const assert = require('node:assert/strict');
const { test } = require('node:test');

const { openDatabase, registerSQLiteImplementation } = require('../.test-lib-cjs/openDatabase.js');

function adapter(label) {
  return {
    label,
    async query() {
      return { values: [{ label }] };
    },
    async run() {
      return { changes: { changes: 0, lastId: 0 } };
    },
    async execute() {},
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
  };
}

function factory(name, options = {}) {
  const state = { opens: 0, closes: 0 };
  return {
    state,
    implementation: {
      useDatabaseCache: options.useDatabaseCache,
      async openDatabase() {
        state.opens++;
        return { db: adapter(`${name}-${state.opens}`) };
      },
      async closeDatabase() {
        state.closes++;
      },
    },
  };
}

test('cached databases close only after their final lease', async () => {
  const implementationName = `cached-${Date.now()}-${Math.random()}`;
  const registered = factory(implementationName);
  registerSQLiteImplementation(implementationName, registered.implementation);

  const options = { name: 'shared.db', sqliteImplementation: implementationName };
  const first = await openDatabase(options);
  const second = await openDatabase(options);
  assert.equal(registered.state.opens, 1);
  assert.equal(first.db, second.db);
  assert.equal(first.transactionQueue, second.transactionQueue);

  await first.close();
  await first.close();
  assert.equal(registered.state.closes, 0);
  assert.deepEqual((await second.db.query('SELECT 1')).values, [
    { label: `${implementationName}-1` },
  ]);

  await second.close();
  assert.equal(registered.state.closes, 1);
});

test('an in-flight open reserves its lease before an existing lease closes', async () => {
  const implementationName = `in-flight-${Date.now()}-${Math.random()}`;
  const registered = factory(implementationName);
  registerSQLiteImplementation(implementationName, registered.implementation);

  const options = { name: 'raced.db', sqliteImplementation: implementationName };
  const first = await openDatabase(options);
  const secondPromise = openDatabase(options);
  await first.close();
  const second = await secondPromise;
  const third = await openDatabase(options);

  assert.equal(registered.state.opens, 1);
  assert.equal(registered.state.closes, 0);
  assert.equal(second.db, first.db);
  assert.equal(third.db, first.db);

  await second.close();
  assert.equal(registered.state.closes, 0);
  await third.close();
  assert.equal(registered.state.closes, 1);
});

test('caller cache options cannot split queues over a factory-owned connection', async () => {
  const implementationName = `caller-cache-${Date.now()}-${Math.random()}`;
  const registered = factory(implementationName);
  registerSQLiteImplementation(implementationName, registered.implementation);

  const options = {
    name: 'factory-policy.db',
    sqliteImplementation: implementationName,
    useDatabaseCache: false,
  };
  const first = await openDatabase(options);
  const second = await openDatabase(options);

  assert.equal(registered.state.opens, 1);
  assert.equal(first.db, second.db);
  assert.equal(first.transactionQueue, second.transactionQueue);

  await first.close();
  await second.close();
  assert.equal(registered.state.closes, 1);
});

test('a new connection waits for the previous native handle to finish closing', async () => {
  const implementationName = `closing-${Date.now()}-${Math.random()}`;
  const registered = factory(implementationName);
  let finishClose;
  const closeGate = new Promise((resolve) => {
    finishClose = resolve;
  });
  registered.implementation.closeDatabase = async () => {
    registered.state.closes++;
    await closeGate;
  };
  registerSQLiteImplementation(implementationName, registered.implementation);

  const options = { name: 'reopen.db', sqliteImplementation: implementationName };
  const first = await openDatabase(options);
  const closing = first.close();
  const secondPromise = openDatabase(options);

  await Promise.resolve();
  assert.equal(registered.state.opens, 1);
  assert.equal(registered.state.closes, 1);

  finishClose();
  await closing;
  const second = await secondPromise;
  assert.equal(registered.state.opens, 2);
  assert.notEqual(second.db, first.db);

  await second.close();
  assert.equal(registered.state.closes, 2);
});

test('uncached databases close their own factory handles', async () => {
  const implementationName = `uncached-${Date.now()}-${Math.random()}`;
  const registered = factory(implementationName, { useDatabaseCache: false });
  registerSQLiteImplementation(implementationName, registered.implementation);

  const options = { name: 'private.db', sqliteImplementation: implementationName };
  const first = await openDatabase(options);
  const second = await openDatabase(options);
  assert.equal(registered.state.opens, 2);
  assert.notEqual(first.db, second.db);

  await first.close();
  await first.close();
  await second.close();
  assert.equal(registered.state.closes, 2);
});

test('cache identity includes the SQLite implementation', async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const firstName = `implementation-a-${suffix}`;
  const secondName = `implementation-b-${suffix}`;
  const firstFactory = factory(firstName);
  const secondFactory = factory(secondName);
  registerSQLiteImplementation(firstName, firstFactory.implementation);
  registerSQLiteImplementation(secondName, secondFactory.implementation);

  const first = await openDatabase({ name: 'same.db', sqliteImplementation: firstName });
  const second = await openDatabase({ name: 'same.db', sqliteImplementation: secondName });
  assert.notEqual(first.db, second.db);
  assert.equal(firstFactory.state.opens, 1);
  assert.equal(secondFactory.state.opens, 1);

  await first.close();
  await second.close();
  assert.equal(firstFactory.state.closes, 1);
  assert.equal(secondFactory.state.closes, 1);
});
