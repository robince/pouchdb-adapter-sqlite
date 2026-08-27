import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';

import cloudflareDOAdapter, {
  CloudflareDODatabase,
  type DurableObjectStorageLike,
} from '../src';

PouchDB.plugin(cloudflareDOAdapter);

export interface Env {
  POUCH_DATABASE: DurableObjectNamespace<PouchDatabase>;
}

export class PouchDatabase extends DurableObject<Env> {
  private readonly db: PouchDB.Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PouchDB('db', {
      adapter: 'sqlite',
      sqliteImplementation: 'cloudflare-do',
      durableObjectStorage: ctx.storage,
    } as PouchDB.Configuration.DatabaseConfiguration);
  }

  async put(doc: Record<string, unknown>) {
    return this.db.put(doc);
  }

  async get(id: string, options?: PouchDB.Core.GetOptions) {
    return this.db.get(id, options);
  }

  async getStatus(id: string): Promise<number> {
    try {
      await this.db.get(id);
      return 200;
    } catch (error) {
      return typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 500;
    }
  }

  async remove(id: string, rev: string) {
    return this.db.remove(id, rev);
  }

  async bulkDocs(docs: Array<Record<string, unknown>>) {
    return this.db.bulkDocs(docs);
  }

  async allDocs(options?: PouchDB.Core.AllDocsOptions) {
    return this.db.allDocs(options);
  }

  async info() {
    return this.db.info();
  }

  async changes(options?: PouchDB.Core.ChangesOptions) {
    return this.db.changes(options);
  }

  async purge(id: string, rev: string) {
    return (this.db as PouchDB.Database & {
      purge(id: string, rev: string): Promise<{
        ok: boolean;
        deletedRevs: string[];
        documentWasRemovedCompletely: boolean;
      }>;
    }).purge(id, rev);
  }

  async transactionRollbackProbe(): Promise<number> {
    const sql = new CloudflareDODatabase(this.ctx.storage as DurableObjectStorageLike);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rollback_probe (value INTEGER)');
    try {
      await sql.transaction(async (db) => {
        await db.run('INSERT INTO rollback_probe (value) VALUES (?)', [1]);
        throw new Error('rollback');
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'rollback') {
        throw error;
      }
    }
    return this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM rollback_probe')
      .one().count;
  }
}

export default {
  fetch(): Response {
    return new Response('pouchdb-adapter-cloudflare-do test worker');
  },
};
