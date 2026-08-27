import { describe, expect, it } from 'vitest';

import type {
  OpenDatabaseOptions,
  OpenDatabaseResult,
  SQLiteAdapter,
  SQLiteImplementationFactory,
} from '../src/interfaces';
import { openDatabase, registerSQLiteImplementation } from '../src/openDatabase';

let implementationSequence = 0;

type OpenedDatabase = Exclude<OpenDatabaseResult, { error: Error }>;

function implementationName(prefix: string): string {
  implementationSequence++;
  return `${prefix}-${implementationSequence}`;
}

function options(name: string, sqliteImplementation: string): OpenDatabaseOptions {
  return { adapter: 'sqlite', name, sqliteImplementation };
}

async function opened(openOptions: OpenDatabaseOptions): Promise<OpenedDatabase> {
  const result = await openDatabase(openOptions);
  if ('error' in result) {
    throw result.error;
  }
  return result;
}

function adapter(label: string): SQLiteAdapter {
  return {
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

function factory(
  name: string,
  factoryOptions: Pick<SQLiteImplementationFactory, 'useDatabaseCache' | 'maxBoundParameters'> = {}
) {
  const state = { opens: 0, closes: 0 };
  const implementation: SQLiteImplementationFactory = {
    ...factoryOptions,
    async openDatabase() {
      state.opens++;
      return { db: adapter(`${name}-${state.opens}`) };
    },
    async closeDatabase() {
      state.closes++;
    },
  };
  return { state, implementation };
}

describe('openDatabase', () => {
  it('closes a cached database only after its final lease', async () => {
    const name = implementationName('cached');
    const registered = factory(name);
    registerSQLiteImplementation(name, registered.implementation);

    const openOptions = options('shared.db', name);
    const first = await opened(openOptions);
    const second = await opened(openOptions);
    expect(registered.state.opens).toBe(1);
    expect(first.db).toBe(second.db);
    expect(first.transactionQueue).toBe(second.transactionQueue);

    await first.close();
    await first.close();
    expect(registered.state.closes).toBe(0);
    expect((await second.db.query('SELECT 1')).values).toEqual([{ label: `${name}-1` }]);

    await second.close();
    expect(registered.state.closes).toBe(1);
  });

  it('reserves an in-flight open before an existing lease closes', async () => {
    const name = implementationName('in-flight');
    const registered = factory(name);
    registerSQLiteImplementation(name, registered.implementation);

    const openOptions = options('raced.db', name);
    const first = await opened(openOptions);
    const secondPromise = opened(openOptions);
    await first.close();
    const second = await secondPromise;
    const third = await opened(openOptions);

    expect(registered.state.opens).toBe(1);
    expect(registered.state.closes).toBe(0);
    expect(second.db).toBe(first.db);
    expect(third.db).toBe(first.db);

    await second.close();
    expect(registered.state.closes).toBe(0);
    await third.close();
    expect(registered.state.closes).toBe(1);
  });

  it('does not let caller options split queues over a factory-owned connection', async () => {
    const name = implementationName('caller-cache');
    const registered = factory(name);
    registerSQLiteImplementation(name, registered.implementation);

    const openOptions: OpenDatabaseOptions & { useDatabaseCache: boolean } = {
      ...options('factory-policy.db', name),
      useDatabaseCache: false,
    };
    const first = await opened(openOptions);
    const second = await opened(openOptions);

    expect(registered.state.opens).toBe(1);
    expect(first.db).toBe(second.db);
    expect(first.transactionQueue).toBe(second.transactionQueue);

    await first.close();
    await second.close();
    expect(registered.state.closes).toBe(1);
  });

  it('waits for the previous native handle to finish closing before reopening', async () => {
    const name = implementationName('closing');
    const registered = factory(name);
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    registered.implementation.closeDatabase = async () => {
      registered.state.closes++;
      await closeGate;
    };
    registerSQLiteImplementation(name, registered.implementation);

    const openOptions = options('reopen.db', name);
    const first = await opened(openOptions);
    const closing = first.close();
    const secondPromise = opened(openOptions);

    await Promise.resolve();
    expect(registered.state.opens).toBe(1);
    expect(registered.state.closes).toBe(1);

    finishClose();
    await closing;
    const second = await secondPromise;
    expect(registered.state.opens).toBe(2);
    expect(second.db).not.toBe(first.db);

    await second.close();
    expect(registered.state.closes).toBe(2);
  });

  it('closes implementation-owned uncached handles independently', async () => {
    const name = implementationName('uncached');
    const registered = factory(name, { useDatabaseCache: false });
    registerSQLiteImplementation(name, registered.implementation);

    const openOptions = options('private.db', name);
    const first = await opened(openOptions);
    const second = await opened(openOptions);
    expect(registered.state.opens).toBe(2);
    expect(first.db).not.toBe(second.db);

    await first.close();
    await first.close();
    await second.close();
    expect(registered.state.closes).toBe(2);
  });

  it('includes the SQLite implementation in cache identity', async () => {
    const firstName = implementationName('implementation-a');
    const secondName = implementationName('implementation-b');
    const firstFactory = factory(firstName);
    const secondFactory = factory(secondName);
    registerSQLiteImplementation(firstName, firstFactory.implementation);
    registerSQLiteImplementation(secondName, secondFactory.implementation);

    const first = await opened(options('same.db', firstName));
    const second = await opened(options('same.db', secondName));
    expect(first.db).not.toBe(second.db);
    expect(firstFactory.state.opens).toBe(1);
    expect(secondFactory.state.opens).toBe(1);

    await first.close();
    await second.close();
    expect(firstFactory.state.closes).toBe(1);
    expect(secondFactory.state.closes).toBe(1);
  });

  it('uses a 999-parameter default and honours implementation-specific limits', async () => {
    const defaultName = implementationName('default-parameters');
    const limitedName = implementationName('limited-parameters');
    const defaultFactory = factory(defaultName);
    const limitedFactory = factory(limitedName, { maxBoundParameters: 100 });
    registerSQLiteImplementation(defaultName, defaultFactory.implementation);
    registerSQLiteImplementation(limitedName, limitedFactory.implementation);

    const defaultDatabase = await opened(options('parameters.db', defaultName));
    const limitedDatabase = await opened(options('parameters.db', limitedName));
    expect(defaultDatabase.maxBoundParameters).toBe(999);
    expect(limitedDatabase.maxBoundParameters).toBe(100);

    await defaultDatabase.close();
    await limitedDatabase.close();
  });
});
