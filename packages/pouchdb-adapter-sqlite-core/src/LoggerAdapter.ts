import {
  BinarySerializer,
  SQLiteLoggerAdapter,
  SQLiteExecuteResult,
  TransactionalSQLiteDatabase,
  SQLiteQueryResult,
  SqlLogOptions,
} from './interfaces';
import { logger } from './logger';

export class LoggerSqliteAdapterWarpper implements SQLiteLoggerAdapter {
  private adapter: TransactionalSQLiteDatabase;
  constructor(adapter: TransactionalSQLiteDatabase) {
    this.adapter = adapter;
    if ('serializer' in adapter) {
      this.serializer = adapter.serializer as BinarySerializer | undefined;
    }
    if ('createBlob' in adapter && typeof adapter.createBlob === 'function') {
      this.createBlob = adapter.createBlob.bind(adapter) as (binary: any, type: any) => any;
    }
    if ('btoa' in adapter && typeof adapter.btoa === 'function') {
      this.btoa = adapter.btoa.bind(adapter) as (data: any) => any;
    }
  }
  serializer?: BinarySerializer | undefined;
  createBlob?: ((binary: any, type: any) => any) | undefined;
  btoa?: ((data: any) => any) | undefined;
  async transaction(fn: (db: TransactionalSQLiteDatabase) => Promise<void>): Promise<void> {
    logger.debug(`transaction`);
    if ('transaction' in this.adapter && typeof this.adapter.transaction === 'function') {
      await this.adapter.transaction(async (scopedDb) => {
        const loggedDb =
          scopedDb === this.adapter ? this : new LoggerSqliteAdapterWarpper(scopedDb);
        await fn(loggedDb);
      });
    } else if (
      'beginTransaction' in this.adapter &&
      typeof this.adapter.beginTransaction === 'function' &&
      'commitTransaction' in this.adapter &&
      typeof this.adapter.commitTransaction === 'function' &&
      'rollbackTransaction' in this.adapter &&
      typeof this.adapter.rollbackTransaction === 'function'
    ) {
      await this.adapter.beginTransaction();
      try {
        await fn(this);
        await this.adapter.commitTransaction();
      } catch (error) {
        try {
          await this.adapter.rollbackTransaction();
        } catch (rollbackError) {
          logger.error('Failed to rollback transaction:', rollbackError);
        }
        throw error;
      }
    } else {
      throw new Error('The wrapped SQLite adapter does not provide a transaction capability');
    }
    logger.debug(`transaction success`);
  }
  query(sql: string, params?: any[], opt?: SqlLogOptions): Promise<SQLiteQueryResult> {
    const logParams = opt?.params ?? params;

    logger.debug(`query: sql %o params %o`, sql, logParams);

    const result = this.adapter.query(sql, params);
    if (opt && !opt.notlogResult)
      logger.debug(`query sql %o with params %o success! result: %o`, sql, logParams, result);
    else
      logger.debug(`query sql %o with params %o success but not log result by opt`, sql, logParams);

    return result;
  }
  async run(sql: string, params?: any[], opt?: SqlLogOptions) {
    const logParams = opt?.params ?? params;
    logger.debug(`run: sql %o params %o`, sql, logParams);
    const result = await this.adapter.run(sql, params);
    if (opt && !opt.notlogResult)
      logger.debug(`run sql %o with params %o success! result: %o`, sql, logParams, result);
    else
      logger.debug(`run sql %o with params %o success but not log result by opt`, sql, logParams);
    return result;
  }
  async execute(sql: string, opt?: SqlLogOptions) {
    const logParams = opt?.params ?? [];
    logger.debug(`execute: sql %o params %o`, sql, logParams);
    const result = this.adapter.execute(sql);
    logger.debug(`execute sql %o success`, sql, logParams);
    return result;
  }
}
