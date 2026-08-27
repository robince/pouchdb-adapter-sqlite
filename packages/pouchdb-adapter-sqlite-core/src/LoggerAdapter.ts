import {
  BinarySerializer,
  SQLiteLoggerAdapter,
  SQLiteExecuteResult,
  SQLiteDatabase,
  SQLiteQueryResult,
  SqlLogOptions,
} from './interfaces';
import { logger } from './logger';

export class LoggerSqliteAdapterWarpper implements SQLiteLoggerAdapter {
  private adapter: SQLiteDatabase;
  constructor(adapter: SQLiteDatabase) {
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

    // Assign this conditionally so the wrapper preserves transaction as a
    // truthful capability probe for legacy begin/commit/rollback adapters.
    if (adapter.transaction) {
      this.transaction = async (fn) => {
        logger.debug(`transaction`);
        await adapter.transaction!(async (scopedDb) => {
          const loggedDb = scopedDb === adapter ? this : new LoggerSqliteAdapterWarpper(scopedDb);
          await fn(loggedDb);
        });
        logger.debug(`transaction success`);
      };
    }
  }
  serializer?: BinarySerializer | undefined;
  createBlob?: ((binary: any, type: any) => any) | undefined;
  btoa?: ((data: any) => any) | undefined;
  transaction?: (fn: (db: SQLiteDatabase) => Promise<void>) => Promise<void>;
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
  async beginTransaction() {
    logger.debug(`beginTransaction`);
    await this.adapter.beginTransaction();
    logger.debug(`beginTransaction success`);
  }
  async commitTransaction() {
    logger.debug(`commitTransaction`);
    await this.adapter.commitTransaction();
    logger.debug(`commitTransaction success`);
  }
  async rollbackTransaction() {
    logger.debug(`rollbackTransaction`);
    await this.adapter.rollbackTransaction();
    logger.debug(`rollbackTransaction success`);
  }
}
