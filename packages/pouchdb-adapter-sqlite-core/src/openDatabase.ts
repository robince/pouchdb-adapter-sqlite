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
}

interface CachedDatabase {
  shared: Promise<SharedDatabase>;
  referenceCount: number;
  closing?: Promise<void>;
}

// Cache connection creation as well as opened handles so concurrent opens of
// the same implementation and database share one native connection.
const cachedDatabases = new Map<string, CachedDatabase>();

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
  };
}

function createCacheEntry(
  factory: SQLiteImplementationFactory,
  options: OpenDatabaseOptions,
  afterClose?: Promise<void>
): CachedDatabase {
  return {
    shared: afterClose
      ? afterClose.catch(() => undefined).then(() => createSharedDatabase(factory, options))
      : createSharedDatabase(factory, options),
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
    // Cache policy belongs to the implementation. A caller cannot safely opt
    // out when a native driver itself returns one connection per database name.
    const useDatabaseCache = factory.useDatabaseCache !== false;

    if (!useDatabaseCache) {
      logger.debug(`Opening uncached database: ${options.name} (${implementationName})`);
      const shared = await createSharedDatabase(factory, options);
      return databaseLease(shared, () => factory.closeDatabase(options.name));
    }

    const key = cacheKey(implementationName, options.name);
    let cached = cachedDatabases.get(key);
    if (!cached) {
      logger.debug(
        `Opening database: ${options.name} (using ${implementationName} implementation)`
      );
      cached = createCacheEntry(factory, options);
      cachedDatabases.set(key, cached);
    } else if (cached.closing) {
      logger.debug(`Waiting for database to close before reopening: ${options.name}`);
      cached = createCacheEntry(factory, options, cached.closing);
      cachedDatabases.set(key, cached);
    } else {
      logger.debug(`Using cached database connection: ${options.name}`);
    }

    // Reserve this lease before yielding. Otherwise the last existing lease
    // can close the shared native handle while this open is awaiting it.
    cached.referenceCount++;

    let shared: SharedDatabase;
    try {
      shared = await cached.shared;
    } catch (error) {
      cached.referenceCount--;
      if (cached.referenceCount === 0 && cachedDatabases.get(key) === cached) {
        cachedDatabases.delete(key);
      }
      throw error;
    }

    return databaseLease(shared, async () => {
      cached.referenceCount--;
      if (cached.referenceCount > 0) {
        return;
      }

      const closing = Promise.resolve().then(() => shared.factory.closeDatabase(shared.name));
      cached.closing = closing;
      try {
        await closing;
      } finally {
        if (cachedDatabases.get(key) === cached) {
          cachedDatabases.delete(key);
        }
      }
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
