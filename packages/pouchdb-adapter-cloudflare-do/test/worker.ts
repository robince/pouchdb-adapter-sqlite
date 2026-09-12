import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';

import cloudflareDOAdapter, { CloudflareDODatabase, cloudflareDOOptions } from '../src';

PouchDB.plugin(cloudflareDOAdapter);

export interface Env {
  POUCH_DATABASE: DurableObjectNamespace<PouchDatabase>;
}

export class PouchDatabase extends DurableObject<Env> {
  private readonly db: PouchDB.Database;
  private temporaryHandleCloses = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PouchDB('db', cloudflareDOOptions(ctx.storage));
  }

  async countOracle() {
    await this.db.info();
    return this.ctx.storage.sql
      .exec<{
        count: number;
      }>(
        'SELECT COUNT(d.id) AS count FROM "document-store" d JOIN "by-sequence" b ON b.seq=d.winningseq WHERE b.deleted=0'
      )
      .one().count;
  }

  async countFailure(stage: string) {
    await this.db.info();
    const storage = this.ctx.storage;
    let armed = false;
    const wrapped = {
      sql: {
        exec: (query: string, ...bindings: any[]) => {
          if (
            armed &&
            ((stage === 'document' && query.startsWith("INSERT INTO 'document-store'")) ||
              (stage === 'counter' && query.includes('SET doc_count = doc_count +')))
          ) {
            throw new Error('injected count failure');
          }
          return storage.sql.exec(query, ...bindings);
        },
      },
      transaction: <T>(fn: () => Promise<T>) =>
        storage.transaction(async () => {
          const result = await fn();
          if (armed && stage === 'commit') throw new Error('injected commit failure');
          return result;
        }),
    };
    const fresh = new PouchDB('db', cloudflareDOOptions(wrapped));
    await fresh.info();
    let rejected = false;
    try {
      armed = true;
      await fresh.bulkDocs([{ _id: 'failed-a' }, { _id: 'failed-b' }]);
    } catch {
      rejected = true;
    } finally {
      armed = false;
      await fresh.close();
    }
    return {
      rejected,
      count: await this.countOracle(),
      persisted: (await this.db.info()).doc_count,
    };
  }

  async bulkFailureProbe() {
    await this.db.info();
    const storage = this.ctx.storage;
    let armed = false;
    let injected = false;
    const wrapped = {
      sql: {
        exec: (query: string, ...bindings: any[]) => {
          const cursor = storage.sql.exec(query, ...bindings);
          if (armed && !injected && query.startsWith("INSERT INTO 'document-store'")) {
            injected = true;
            throw new Error('injected after document insert');
          }
          return cursor;
        },
      },
      transaction: <T>(fn: () => Promise<T>) => storage.transaction(fn),
    };
    const fresh = new PouchDB('db', cloudflareDOOptions(wrapped));
    try {
      let rejected = false;
      let reason: string | undefined;
      try {
        await fresh.info();
        armed = true;
        await fresh.bulkDocs([{ _id: 'failed-a' }, { _id: 'failed-b' }]);
      } catch (error) {
        rejected = true;
        if (typeof error === 'object' && error !== null && 'reason' in error) {
          reason = String((error as { reason: unknown }).reason);
        } else {
          reason = String(error);
        }
      } finally {
        armed = false;
      }

      const physical = {
        documents: storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM 'document-store'")
          .one().count,
        sequences: storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM 'by-sequence'")
          .one().count,
        docCount: storage.sql
          .exec<{ doc_count: number }>("SELECT doc_count FROM 'metadata-store'")
          .one().doc_count,
        maxSequence: storage.sql
          .exec<{ sequence: number }>("SELECT COALESCE(MAX(seq), 0) AS sequence FROM 'by-sequence'")
          .one().sequence,
        sqliteSequence: storage.sql
          .exec<{
            sequence: number;
          }>(
            "SELECT COALESCE(MAX(seq), 0) AS sequence FROM sqlite_sequence WHERE name='by-sequence'"
          )
          .one().sequence,
      };
      const status = async (id: string) => {
        try {
          await fresh.get(id);
          return 200;
        } catch (error) {
          return typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 500;
        }
      };
      const beforeInfo = await fresh.info();
      const beforeFollowUp = {
        info: beforeInfo,
        rows: (await fresh.allDocs()).rows.map((row) => row.id),
        changes: (await fresh.changes({ since: 0 })).results.map((row) => row.id),
        failedA: await status('failed-a'),
        failedB: await status('failed-b'),
      };
      const followUp = await fresh.bulkDocs([{ _id: 'after-failure' }]);
      const afterInfo = await fresh.info();
      const afterFollowUp = {
        info: afterInfo,
        rows: (await fresh.allDocs()).rows.map((row) => row.id),
        changes: (await fresh.changes({ since: 0 })).results.map((row) => row.id),
        results: followUp.map((result) => ({ ok: result.ok, id: result.id })),
      };
      return { rejected, reason, injected, physical, beforeFollowUp, afterFollowUp };
    } finally {
      await fresh.close();
    }
  }

  async countProbe(kind: string) {
    await this.db.info();
    const setup = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      await setup.info();
    } finally {
      await setup.close();
    }
    const sql = this.ctx.storage.sql;
    const originalSchema = sql
      .exec("SELECT sql FROM sqlite_master WHERE name='metadata-store'")
      .one().sql as string;
    const originalMetadata = sql
      .exec('SELECT dbid, db_version, doc_count FROM "metadata-store"')
      .one();
    if (kind.startsWith('migration')) {
      if (kind !== 'migration-existing')
        sql.exec('ALTER TABLE "metadata-store" DROP COLUMN doc_count');
      else sql.exec('UPDATE "metadata-store" SET doc_count=123');
      sql.exec('UPDATE "metadata-store" SET db_version=1');
      // Reproduce the old adapter's ADD COLUMN without populating its value.
      if (kind === 'migration-null') sql.exec('UPDATE "metadata-store" SET db_version=NULL');
      if (kind === 'migration-legacy')
        sql.exec('ALTER TABLE "metadata-store" DROP COLUMN db_version');
    } else if (kind === 'missing-count')
      sql.exec('ALTER TABLE "metadata-store" DROP COLUMN doc_count');
    else if (kind === 'fraction') sql.exec('UPDATE "metadata-store" SET doc_count=0.5');
    else if (kind === 'future') sql.exec('UPDATE "metadata-store" SET db_version=99');
    else if (kind === 'missing') sql.exec('DELETE FROM "metadata-store"');
    else if (kind === 'duplicate')
      sql.exec('INSERT INTO "metadata-store" SELECT * FROM "metadata-store"');
    else if (kind === 'unsafe') sql.exec('UPDATE "metadata-store" SET doc_count=9007199254740992');
    const fresh = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      return await fresh.info();
    } catch {
      return { rejected: true };
    } finally {
      await fresh.close().catch(() => {});
      if (!kind.startsWith('migration')) {
        // Invalid-schema probes must not poison subsequent RPCs on the shared handle.
        await this.ctx.storage.transaction(async () => {
          sql.exec('DROP TABLE "metadata-store"');
          sql.exec(originalSchema);
          sql.exec(
            'INSERT INTO "metadata-store" (dbid, db_version, doc_count) VALUES (?, ?, ?)',
            originalMetadata.dbid,
            originalMetadata.db_version,
            originalMetadata.doc_count
          );
        });
      }
    }
  }

  async migratedConflictProbe(newEdits: boolean) {
    await this.db.info();
    const setup = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      await setup.bulkDocs(
        [
          { _id: 'a', _rev: '1-z' },
          { _id: 'a', _rev: '1-b' },
        ],
        { new_edits: false }
      );
      await setup.bulkDocs(
        [{ _id: 'a', _rev: '2-c', _deleted: true, _revisions: { start: 2, ids: ['c', 'b'] } }],
        { new_edits: false }
      );
    } finally {
      await setup.close();
    }
    this.ctx.storage.sql.exec('ALTER TABLE "metadata-store" DROP COLUMN doc_count');
    this.ctx.storage.sql.exec('UPDATE "metadata-store" SET db_version=1');
    const fresh = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      const before = (await fresh.info()).doc_count;
      if (newEdits) await fresh.put({ _id: 'a', _rev: '1-z', value: 'updated' });
      else
        await fresh.bulkDocs(
          [{ _id: 'a', _rev: '2-z', _revisions: { start: 2, ids: ['z', 'z'] } }],
          { new_edits: false }
        );
      const after = (await fresh.info()).doc_count;
      const all = (await fresh.allDocs({})).total_rows;
      return { before, after, all };
    } finally {
      await fresh.close();
    }
  }

  async attachmentFailureProbe() {
    await this.db.put({
      _id: 'attached',
      _attachments: { 'a.txt': { content_type: 'text/plain', data: 'YQ==' } },
    });
    let rejected = false;
    try {
      await this.db.bulkDocs([
        {
          _id: 'invalid',
          _attachments: {
            'missing.txt': { stub: true, digest: 'missing', content_type: 'text/plain' },
          },
        },
      ]);
    } catch {
      rejected = true;
    }
    await this.db.bulkDocs([{ _id: '_local/only' }]);
    return { rejected, count: (await this.db.info()).doc_count, oracle: await this.countOracle() };
  }

  async concurrentCountProbe() {
    await this.db.info();
    const fresh = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      await fresh.info();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? fresh : this.db).put({ _id: `concurrent-${i}` })
        )
      );
      return {
        first: (await this.db.info()).doc_count,
        second: (await fresh.info()).doc_count,
        oracle: await this.countOracle(),
      };
    } finally {
      await fresh.close();
    }
  }

  async migrationFailure(stage: string) {
    await this.db.info();
    const setup = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      await setup.put({ _id: 'survivor' });
    } finally {
      await setup.close();
    }
    const storage = this.ctx.storage;
    storage.sql.exec('ALTER TABLE "metadata-store" DROP COLUMN doc_count');
    storage.sql.exec('UPDATE "metadata-store" SET db_version=1');
    let recounts = 0;
    let fail = true;
    const wrapped = {
      sql: {
        exec: (query: string, ...bindings: any[]) => {
          const cursor = storage.sql.exec(query, ...bindings);
          if (query.includes('SELECT COUNT(d.id)')) recounts++;
          if (
            fail &&
            ((stage === 'column' && query.includes('ADD COLUMN doc_count')) ||
              (stage === 'count' && query.includes('SET doc_count = ?')) ||
              (stage === 'version' && query.includes('SET db_version = ?')))
          )
            throw new Error('migration failure');
          return cursor;
        },
      },
      transaction: <T>(fn: () => Promise<T>) => storage.transaction(fn),
    };
    const broken = new PouchDB('db', cloudflareDOOptions(wrapped));
    let rejected = false;
    try {
      await broken.info();
    } catch {
      rejected = true;
    }
    await broken.close().catch(() => {});
    const version = storage.sql.exec('SELECT db_version FROM "metadata-store"').one().db_version;
    const hasCount = storage.sql
      .exec('PRAGMA table_info("metadata-store")')
      .toArray()
      .some((row) => row.name === 'doc_count');
    fail = false;
    recounts = 0;
    const fresh = new PouchDB('db', cloudflareDOOptions(wrapped));
    let info: PouchDB.Core.DatabaseInfo;
    try {
      info = await fresh.info();
    } finally {
      await fresh.close();
    }
    const migrationRecounts = recounts;
    const reopened = new PouchDB('db', cloudflareDOOptions(wrapped));
    try {
      await reopened.info();
    } finally {
      await reopened.close();
    }
    return { rejected, version, hasCount, count: info.doc_count, migrationRecounts, recounts };
  }

  async countLifecycleProbe() {
    await this.db.info();
    const options = {
      ...cloudflareDOOptions(this.ctx.storage),
      auto_compaction: true,
      revs_limit: 2,
    };
    const fresh = new PouchDB('db', options);
    try {
      for (let i = 0; i < 5; i++) {
        const doc = i ? await fresh.get('history') : { _id: 'history' };
        await fresh.put({ ...doc, value: i });
      }
      await fresh.compact();
      const count = (await fresh.info()).doc_count;
      const oracle = await this.countOracle();
      await fresh.destroy();
      const recreated = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
      try {
        return { count, oracle, recreated: (await recreated.info()).doc_count };
      } finally {
        await recreated.close();
      }
    } finally {
      await fresh.close().catch(() => {});
    }
  }

  async measuredCounts(size: number, depth: number, deletedFraction: number) {
    await this.db.bulkDocs(Array.from({ length: size }, (_, i) => ({ _id: `bench-${i}` })));
    for (let revision = 1; revision < depth; revision++) {
      const all = await this.db.allDocs({ include_docs: true });
      await this.db.bulkDocs(all.rows.map((row) => ({ ...row.doc!, value: revision })));
    }
    const all = await this.db.allDocs({ include_docs: true });
    await this.db.bulkDocs(
      all.rows
        .slice(0, Math.floor(size * deletedFraction))
        .map((row) => ({ ...row.doc!, _deleted: true }))
    );
    let legacyCount = false;
    let reads = 0,
      writes = 0,
      updates = 0;
    const storage = this.ctx.storage;
    const measured = {
      sql: {
        exec: (query: string, ...bindings: any[]) => {
          if (legacyCount && query.startsWith('SELECT doc_count FROM')) {
            query =
              'SELECT COUNT(d.id) AS doc_count FROM "document-store" d JOIN "by-sequence" b ON b.seq=d.winningseq WHERE b.deleted=0';
          }
          const cursor = storage.sql.exec(query, ...bindings);
          const rows = cursor.toArray();
          reads += cursor.rowsRead;
          writes += cursor.rowsWritten;
          if (query.includes('SET doc_count = doc_count +')) updates++;
          return { toArray: () => rows, rowsWritten: cursor.rowsWritten };
        },
      },
      transaction: <T>(fn: () => Promise<T>) => storage.transaction(fn),
    };
    const fresh = new PouchDB('db', cloudflareDOOptions(measured));
    await fresh.info();
    const result: Record<string, unknown> = {};
    const measure = async (name: string, operation: () => Promise<unknown>) => {
      reads = writes = updates = 0;
      await operation();
      result[name] = { reads, writes, updates };
    };
    try {
      await measure('info', () => fresh.info());
      const live = (await fresh.allDocs({ limit: 1 })).rows[0].id;
      await measure('keys', () => fresh.allDocs({ keys: [live] }));
      await measure('limit0', () => fresh.allDocs({ limit: 0 }));
      legacyCount = true;
      await measure('baselineInfo', () => fresh.info());
      await measure('baselineKeys', () => fresh.allDocs({ keys: [live] }));
      await measure('baselineLimit0', () => fresh.allDocs({ limit: 0 }));
      legacyCount = false;
      const doc = await fresh.get(live);
      await measure('update', () => fresh.put({ ...doc, value: 'updated' }));
      const updated = await fresh.get(live);
      await measure('netZero', () =>
        fresh.bulkDocs([{ ...updated, _deleted: true }, { _id: 'replacement' }])
      );
      await measure('create', () => fresh.bulkDocs([{ _id: 'extra-a' }, { _id: 'extra-b' }]));
      await measure('recount', async () =>
        measured.sql
          .exec(
            'SELECT COUNT(d.id) AS count FROM "document-store" d JOIN "by-sequence" b ON b.seq=d.winningseq WHERE b.deleted=0'
          )
          .toArray()
      );
      return result;
    } finally {
      await fresh.close();
    }
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
    return (await this.db.bulkDocs(docs, options)).map((result) => ({ ...result }));
  }

  async allDocs(options?: PouchDB.Core.AllDocsOptions) {
    return this.db.allDocs(options || {});
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

  async purgeOnFreshHandle(id: string, rev: string) {
    const fresh = new PouchDB('db', cloudflareDOOptions(this.ctx.storage));
    try {
      return await (
        fresh as PouchDB.Database & {
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
    } finally {
      await fresh.close();
      this.temporaryHandleCloses++;
    }
  }

  async temporaryHandleFailureProbe(
    operation: 'purge' | 'auto-compaction'
  ): Promise<{ rejected: boolean; closed: boolean }> {
    const closesBefore = this.temporaryHandleCloses;
    try {
      if (operation === 'purge') {
        await this.purgeOnFreshHandle('missing', '1-missing');
      } else {
        await this.autoCompactionProbe('_invalid');
      }
      return { rejected: false, closed: false };
    } catch {
      return {
        rejected: true,
        closed: this.temporaryHandleCloses === closesBefore + 1,
      };
    }
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

  async autoCompactionProbe(id = 'auto-compact'): Promise<number> {
    const db = new PouchDB('db', {
      ...cloudflareDOOptions(this.ctx.storage),
      auto_compaction: true,
    });
    try {
      let doc = await db.get(id).catch(() => ({ _id: id }));
      await db.put({ ...doc, value: 1 });
      doc = await db.get(id);
      await db.put({ ...doc, value: 2 });

      return this.ctx.storage.sql
        .exec<{
          count: number;
        }>("SELECT COUNT(*) AS count FROM 'by-sequence' WHERE doc_id=?", id)
        .one().count;
    } finally {
      await db.close();
      this.temporaryHandleCloses++;
    }
  }
}

export default {
  fetch(): Response {
    return new Response('pouchdb-adapter-cloudflare-do test worker');
  },
};
