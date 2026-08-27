import {
  OpenDatabaseOptions,
  OpenDatabaseResult,
  SQLiteAdapter,
  SQLiteImplementationFactory,
  TransactionQueue as TransactionQueueLike,
} from './interfaces';
import { logger } from './logger';
import { LoggerSqliteAdapterWarpper } from './LoggerAdapter';
import { TransactionQueue as DefaultTransactionQueue } from './transactionQueue';

// Stores registered SQLite implementation factories
const implementationFactories = new Map<string, SQLiteImplementationFactory>();

interface SharedDatabase {
  db: SQLiteAdapter;
  transactionQueue: TransactionQueueLike;
  factory: SQLiteImplementationFactory;
  name: string;
  referenceCount: number;
}

// Cache connection creation as well as opened handles so concurrent opens of
// the same implementation and database share one native connection.
const cachedDatabases = new Map<string, Promise<SharedDatabase>>();

function cacheKey(implementationName: string, name: string): string {
  return JSON.stringify([implementationName, name]);
}

async function createSharedDatabase(
  factory: SQLiteImplementationFactory,
  options: OpenDatabaseOptions
): Promise<SharedDatabase> {
  const result = await factory.openDatabase(options);
  if ('error' in result) {
    throw result.error;
  }

  const db = new LoggerSqliteAdapterWarpper(result.db);
  return {
    db,
    transactionQueue: result.transactionQueue ?? new DefaultTransactionQueue(db),
    factory,
    name: options.name,
    referenceCount: 0,
  };
}

function databaseLease(shared: SharedDatabase, release: () => Promise<void>): OpenDatabaseResult {
  let released = false;
  return {
    db: shared.db,
    transactionQueue: shared.transactionQueue,
    async close() {
      if (released) {
        return;
      }
      released = true;
      await release();
    },
  };
}

/**
 * Register SQLite implementation factory
 * @param name Implementation name
 * @param factory Implementation factory
 */
export function registerSQLiteImplementation(
  name: string,
  factory: SQLiteImplementationFactory
): void {
  implementationFactories.set(name, factory);
  logger.debug(`Registered SQLite implementation: ${name}`);
}

/**
 * Get SQLite implementation factory
 * @param name Implementation name
 * @returns SQLite implementation factory
 * @throws If the specified implementation is not found
 */
export function getSQLiteImplementation(name: string): SQLiteImplementationFactory {
  const factory = implementationFactories.get(name);
  if (!factory) {
    throw new Error(`SQLite implementation not found: ${name}`);
  }
  return factory;
}

/**
 * Open database
 * @param options Database open options
 * @returns Database open result
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<OpenDatabaseResult> {
  const implementationName = options.sqliteImplementation || 'default';

  try {
    const factory = getSQLiteImplementation(implementationName);
    const useDatabaseCache =
      options.useDatabaseCache !== false && factory.useDatabaseCache !== false;

    if (!useDatabaseCache) {
      logger.debug(`Opening uncached database: ${options.name} (${implementationName})`);
      const shared = await createSharedDatabase(factory, options);
      shared.referenceCount = 1;
      return databaseLease(shared, () => factory.closeDatabase(options.name));
    }

    const key = cacheKey(implementationName, options.name);
    let sharedPromise = cachedDatabases.get(key);
    if (!sharedPromise) {
      logger.debug(`Opening database: ${options.name} (using ${implementationName} implementation)`);
      sharedPromise = createSharedDatabase(factory, options);
      cachedDatabases.set(key, sharedPromise);
    } else {
      logger.debug(`Using cached database connection: ${options.name}`);
    }

    let shared: SharedDatabase;
    try {
      shared = await sharedPromise;
    } catch (error) {
      if (cachedDatabases.get(key) === sharedPromise) {
        cachedDatabases.delete(key);
      }
      throw error;
    }
    shared.referenceCount++;

    return databaseLease(shared, async () => {
      shared.referenceCount--;
      if (shared.referenceCount > 0) {
        return;
      }
      if (cachedDatabases.get(key) === sharedPromise) {
        cachedDatabases.delete(key);
      }
      await shared.factory.closeDatabase(shared.name);
    });
  } catch (error) {
    logger.error(`Failed to open database: ${options.name}`, error);
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Get default SQLite implementation name
 * @returns Default implementation name
 */
export function getDefaultImplementation(): string {
  // If there's only one implementation, return it
  if (implementationFactories.size === 1) {
    return Array.from(implementationFactories.keys())[0];
  }

  // Otherwise return 'default' if it exists
  return implementationFactories.has('default')
    ? 'default'
    : Array.from(implementationFactories.keys())[0];
}

export default openDatabase;
