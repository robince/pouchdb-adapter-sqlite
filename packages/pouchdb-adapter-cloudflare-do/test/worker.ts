import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';

import cloudflareDOAdapter, { CloudflareDODatabase, cloudflareDOOptions } from '../src';

PouchDB.plugin(cloudflareDOAdapter);

export interface Env {
  POUCH_DATABASE: DurableObjectNamespace<PouchDatabase>;
}

export class PouchDatabase extends DurableObject<Env> {
  private readonly db: PouchDB.Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PouchDB('db', cloudflareDOOptions(ctx.storage));
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

  async bulkDocs(docs: Array<Record<string, unknown>>, options?: PouchDB.Core.BulkDocsOptions) {
    return this.db.bulkDocs(docs, options);
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
    return (
      this.db as PouchDB.Database & {
        purge(
          id: string,
          rev: string
        ): Promise<{
          ok: boolean;
          deletedRevs: string[];
          documentWasRemovedCompletely: boolean;
        }>;
      }
    ).purge(id, rev);
  }

  async rawAllDocs(options: Record<string, unknown>): Promise<PouchDB.Core.AllDocsResponse<{}>> {
    return new Promise((resolve, reject) => {
      (this.db as any)._allDocs(options, (error: unknown, response: unknown) => {
        if (error) {
          reject(error);
        } else {
          resolve(response as PouchDB.Core.AllDocsResponse<{}>);
        }
      });
    });
  }

  async rawPurgeStatus(id: string, revs: string[]): Promise<number> {
    return new Promise((resolve) => {
      (this.db as any)._purge(id, revs, (error: unknown) => {
        resolve(
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : error
              ? 500
              : 200
        );
      });
    });
  }

  async runResultProbe(): Promise<{
    insertedChanges: number;
    insertedId: number;
    missingChanges: number;
  }> {
    const sql = new CloudflareDODatabase(this.ctx.storage);
    await sql.execute('CREATE TABLE result_probe (id INTEGER PRIMARY KEY, value TEXT)');
    await sql.execute('CREATE INDEX result_probe_value ON result_probe (value)');
    const inserted = await sql.run('INSERT INTO result_probe (value) VALUES (?)', ['value']);
    const missing = await sql.run('UPDATE result_probe SET value=? WHERE id=?', ['missing', 999]);
    return {
      insertedChanges: inserted.changes?.changes ?? -1,
      insertedId: inserted.changes?.lastId ?? -1,
      missingChanges: missing.changes?.changes ?? -1,
    };
  }

  attachmentStorageCounts(digest: string): { mappings: number; bodies: number } {
    const mappings = this.ctx.storage.sql
      .exec<{
        count: number;
      }>("SELECT COUNT(*) AS count FROM 'attach-seq-store' WHERE digest=?", digest)
      .one().count;
    const bodies = this.ctx.storage.sql
      .exec<{
        count: number;
      }>("SELECT COUNT(*) AS count FROM 'attach-store' WHERE digest=?", digest)
      .one().count;
    return { mappings, bodies };
  }

  async transactionRollbackProbe(): Promise<number> {
    const sql = new CloudflareDODatabase(this.ctx.storage);
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
