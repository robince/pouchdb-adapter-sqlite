import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { openCloudflareDODatabase } from '../src';

function database(name: string) {
  return env.POUCH_DATABASE.getByName(name);
}

describe('PouchDB Durable Object SQLite adapter', () => {
  it('supports the document lifecycle and reports PouchDB metadata', async () => {
    const db = database('lifecycle');
    const created = await db.put({ _id: 'alpha', value: 1 });
    expect(created.ok).toBe(true);

    const first = await db.get('alpha');
    expect(first.value).toBe(1);
    const updated = await db.put({ ...first, value: 2 });
    expect(updated.ok).toBe(true);

    expect((await db.get('alpha')).value).toBe(2);
    expect(await db.info()).toMatchObject({ doc_count: 1, update_seq: 2 });

    await db.remove('alpha', updated.rev);
    expect(await db.getStatus('alpha')).toBe(404);
    expect((await db.info()).doc_count).toBe(0);
  });

  it('supports bulk writes, allDocs, and changes', async () => {
    const db = database('queries');
    await db.bulkDocs([
      { _id: 'a', rank: 1 },
      { _id: 'b', rank: 2 },
      { _id: 'c', rank: 3 },
    ]);

    const all = await db.allDocs({ include_docs: true });
    expect(all.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(all.rows[1].doc?.rank).toBe(2);

    const changes = await db.changes({ since: 0, include_docs: true });
    expect(changes.results.map((change) => change.id)).toEqual(['a', 'b', 'c']);
    expect(changes.last_seq).toBe(3);
  });

  it('finishes attachment reads before allDocs and changes complete', async () => {
    const db = database('attachment-reads');
    await db.put({
      _id: 'attached',
      _attachments: {
        'file.txt': {
          content_type: 'text/plain',
          data: 'YXR0YWNobWVudA==',
        },
      },
    });

    const all = await db.allDocs({ include_docs: true, attachments: true });
    expect(all.rows[0].doc?._attachments?.['file.txt'].data).toBe('YXR0YWNobWVudA==');
    expect(all.total_rows).toBe(await db.countOracle());

    const changes = await db.changes({ since: 0, include_docs: true, attachments: true });
    expect(changes.results[0].doc?._attachments?.['file.txt'].data).toBe('YXR0YWNobWVudA==');
  });

  it('batches changes doc_ids while preserving global sequence order and limit', async () => {
    const db = database('changes-doc-ids');
    const documents = Array.from({ length: 130 }, (_, index) => ({
      _id: `doc-${String(index).padStart(3, '0')}`,
      value: index,
    }));
    await db.bulkDocs(documents);

    const docIds = documents.map((doc) => doc._id).reverse();
    docIds.push('doc-100');
    const allChanges = await db.changes({ since: 20, doc_ids: docIds });
    expect(allChanges.results).toHaveLength(110);
    expect(allChanges.results[0].id).toBe('doc-020');
    expect(allChanges.results.at(-1)?.id).toBe('doc-129');
    expect(allChanges.last_seq).toBe(130);

    const changes = await db.changes({
      since: 20,
      doc_ids: docIds,
      limit: 10,
    });

    expect(changes.results.map((change) => change.id)).toEqual(
      documents.slice(20, 30).map((doc) => doc._id)
    );
    expect(changes.last_seq).toBe(30);
  });

  it('keeps identically named PouchDB databases isolated by Durable Object', async () => {
    const left = database('isolation-left');
    const right = database('isolation-right');
    await left.put({ _id: 'only-left' });

    expect((await left.info()).doc_count).toBe(1);
    expect((await right.info()).doc_count).toBe(0);
  });

  it('rolls back a failed callback transaction', async () => {
    expect(await database('rollback').transactionRollbackProbe()).toBe(0);
  });

  it('honours PouchDB auto-compaction options', async () => {
    expect(await database('auto-compaction').autoCompactionProbe()).toBe(1);
  });

  it.each(['purge', 'auto-compaction'] as const)(
    'closes the temporary handle when the %s probe fails',
    async (probe) => {
      expect(await database(`temporary-close-${probe}`).temporaryHandleFailureProbe(probe)).toEqual(
        {
          rejected: true,
          closed: true,
        }
      );
    }
  );

  it('reports SQLite affected rows rather than billable storage writes', async () => {
    expect(await database('run-results').runResultProbe()).toEqual({
      insertedChanges: 1,
      insertedId: 1,
      missingChanges: 0,
    });
  });

  it.each(['sql', 'transaction'] as const)(
    'rejects storage with a non-callable %s method',
    async (invalidMethod) => {
      const durableObjectStorage =
        invalidMethod === 'sql'
          ? { sql: { exec: true }, transaction: async () => undefined }
          : { sql: { exec: () => ({}) }, transaction: true };
      const openOptions = {
        adapter: 'sqlite' as const,
        name: 'invalid.db',
        sqliteImplementation: 'cloudflare-do',
        durableObjectStorage,
      };

      const result = await openCloudflareDODatabase(openOptions);
      expect(result).toHaveProperty(
        'error.message',
        'durableObjectStorage must be ctx.storage from a SQLite-backed Durable Object'
      );
    }
  );

  it('supports purge and allDocs key sets larger than the DO binding limit', async () => {
    const db = database('purge-and-keys');
    const documents = Array.from({ length: 150 }, (_, index) => ({
      _id: `doc-${String(index).padStart(3, '0')}`,
      value: index,
    }));
    await db.bulkDocs(documents);

    const all = await db.allDocs({ keys: documents.map((doc) => doc._id) });
    expect(all.rows).toHaveLength(150);

    const paged = await db.rawAllDocs({
      keys: documents.map((doc) => doc._id),
      skip: 5,
      limit: 10,
    });
    expect(paged.rows.map((row) => row.id)).toEqual(documents.slice(5, 15).map((doc) => doc._id));

    expect((await db.allDocs({ keys: [] })).rows).toEqual([]);

    const doomed = await db.get('doc-000');
    expect(await db.purge('doc-000', doomed._rev)).toMatchObject({
      ok: true,
      deletedRevs: [doomed._rev],
      documentWasRemovedCompletely: true,
    });
    expect(await db.getStatus('doc-000')).toBe(404);
  });

  it('routes purge through revision-tree lookup when it is the first operation', async () => {
    const db = database('fresh-handle-purge');
    const created = await db.put({ _id: 'purge-first' });

    expect(await db.purgeOnFreshHandle('purge-first', created.rev)).toMatchObject({
      ok: true,
      deletedRevs: [created.rev],
      documentWasRemovedCompletely: true,
    });
    expect(await db.getStatus('purge-first')).toBe(404);
  });

  it('purges revision paths larger than the Durable Object parameter limit', async () => {
    const db = database('deep-purge');
    const depth = 60;
    const revisionId = (generation: number) => generation.toString(16).padStart(32, '0');
    const revisions = Array.from({ length: depth }, (_, index) => {
      const generation = index + 1;
      return {
        _id: 'deep-history',
        _rev: `${generation}-${revisionId(generation)}`,
        _revisions: {
          start: generation,
          ids: Array.from({ length: generation }, (_value, ancestor) =>
            revisionId(generation - ancestor)
          ),
        },
      };
    });
    const written = await db.bulkDocs(revisions, { new_edits: false });
    expect(written.every((result) => result.ok)).toBe(true);
    expect((await db.info()).update_seq).toBe(depth);

    const purged = await db.purge('deep-history', `${depth}-${revisionId(depth)}`);
    expect(purged.deletedRevs).toHaveLength(depth);
    expect(purged.documentWasRemovedCompletely).toBe(true);
    expect((await db.info()).update_seq).toBe(depth);
  });

  it('removes purged attachment mappings before deleting orphaned bodies', async () => {
    const db = database('attachment-purge');
    const created = await db.put({
      _id: 'shared-attachment',
      _attachments: {
        'shared.txt': {
          content_type: 'text/plain',
          data: 'c2hhcmVk',
        },
      },
    });
    const root = await db.get('shared-attachment');
    const attachment = root._attachments?.['shared.txt'];
    if (!attachment) {
      throw new Error('missing attachment stub');
    }
    const rootHash = created.rev.slice(created.rev.indexOf('-') + 1);
    const stub = { ...attachment, stub: true };

    await db.bulkDocs(
      [
        {
          _id: 'shared-attachment',
          _rev: '2-left',
          _revisions: { start: 2, ids: ['left', rootHash] },
          _attachments: { 'shared.txt': stub },
        },
        {
          _id: 'shared-attachment',
          _rev: '2-right',
          _revisions: { start: 2, ids: ['right', rootHash] },
          _attachments: { 'shared.txt': stub },
        },
      ],
      { new_edits: false }
    );

    await db.purge('shared-attachment', '2-left');
    expect(await db.attachmentStorageCounts(attachment.digest)).toEqual({ mappings: 2, bodies: 1 });

    const finalPurge = await db.purge('shared-attachment', '2-right');
    expect(finalPurge.documentWasRemovedCompletely).toBe(true);
    expect(await db.attachmentStorageCounts(attachment.digest)).toEqual({ mappings: 0, bodies: 0 });
  });

  it('does not duplicate attachment mappings when an existing revision is replayed', async () => {
    const db = database('attachment-replay');
    await db.put({
      _id: 'attached',
      _attachments: {
        'file.txt': {
          content_type: 'text/plain',
          data: 'cmVwbGF5',
        },
      },
    });
    const revision = await db.get('attached', { revs: true });
    const attachment = revision._attachments?.['file.txt'];
    if (!attachment) {
      throw new Error('missing attachment stub');
    }

    await db.bulkDocs([revision], { new_edits: false });

    expect(await db.attachmentStorageCounts(attachment.digest)).toEqual({ mappings: 1, bodies: 1 });
  });
  it('keeps purge sequence metadata aligned with surviving revisions', async () => {
    const db = database('purge-sequences');
    await db.bulkDocs(
      [
        {
          _id: 'conflicted',
          _rev: '1-root',
          value: 'root',
          _revisions: { start: 1, ids: ['root'] },
        },
        {
          _id: 'conflicted',
          _rev: '2-left',
          value: 'left',
          _revisions: { start: 2, ids: ['left', 'root'] },
        },
        {
          _id: 'conflicted',
          _rev: '2-right',
          value: 'right',
          _revisions: { start: 2, ids: ['right', 'root'] },
        },
      ],
      { new_edits: false }
    );

    expect((await db.get('conflicted'))._rev).toBe('2-right');
    expect((await db.info()).update_seq).toBe(3);
    await db.purge('conflicted', '2-right');

    const afterPurge = await db.info();
    expect(afterPurge.update_seq).toBe(3);
    expect((await db.get('conflicted'))._rev).toBe('2-left');
    expect((await db.changes({ since: afterPurge.update_seq })).results).toEqual([]);

    await db.put({ _id: 'after-purge' });
    expect((await db.info()).update_seq).toBe(4);
    expect(
      (await db.changes({ since: afterPurge.update_seq })).results.map((row) => row.id)
    ).toEqual(['after-purge']);
  });

  it('preserves PouchDB errors raised inside the purge transaction', async () => {
    expect(await database('purge-errors').rawPurgeStatus('missing', ['1-missing'])).toBe(404);
  });
});

describe('persistent document counts', () => {
  async function exact(db: ReturnType<typeof database>, expected?: number) {
    const oracle = await db.countOracle();
    expect((await db.info()).doc_count).toBe(oracle);
    expect((await db.allDocs()).total_rows).toBe(oracle);
    if (expected !== undefined) expect(oracle).toBe(expected);
  }
  it('counts live transitions, local/design documents, partial failures and purge', async () => {
    const db = database('count-transitions');
    await exact(db, 0);
    await db.bulkDocs([{ _id: 'a' }, { _id: '_design/example' }, { _id: '_local/checkpoint' }]);
    await exact(db, 2);
    await db.bulkDocs([{ _id: 'a' }, { _id: 'b' }]);
    await exact(db, 3);
    const a = await db.get('a');
    await db.remove('a', a._rev);
    await exact(db, 2);
    await db.put({ _id: 'a' });
    await exact(db, 3);
    const b = await db.get('b');
    await db.purge('b', b._rev);
    await exact(db, 2);
  });
  it.each([true, false])('ignores stale deleted flags with new_edits=%s', async (newEdits) => {
    const db = database(`count-conflict-${newEdits}`);
    await db.bulkDocs(
      [
        { _id: 'a', _rev: '1-z' },
        { _id: 'a', _rev: '1-b' },
      ],
      { new_edits: false }
    );
    await exact(db, 1);
    if (newEdits) {
      await db.bulkDocs([
        { _id: 'a', _rev: '1-b', _deleted: true },
        { _id: 'a', _rev: '1-z', value: 1 },
      ]);
    } else {
      await db.bulkDocs(
        [
          { _id: 'a', _rev: '2-c', _deleted: true, _revisions: { start: 2, ids: ['c', 'b'] } },
          { _id: 'a', _rev: '2-z', _revisions: { start: 2, ids: ['z', 'z'] } },
        ],
        { new_edits: false }
      );
    }
    await exact(db, 1);
  });
  it.each(['document', 'counter', 'commit'])('rolls back %s failures', async (stage) => {
    expect(await database(`count-failure-${stage}`).countFailure(stage)).toEqual({
      rejected: true,
      count: 0,
      persisted: 0,
    });
  });
  it.each(['column', 'count', 'version'])(
    'rolls back interrupted migration after %s',
    async (stage) => {
      expect(await database(`count-migration-failure-${stage}`).migrationFailure(stage)).toEqual({
        rejected: true,
        version: 1,
        hasCount: false,
        count: 1,
        migrationRecounts: 1,
        recounts: 1,
      });
    }
  );
  it('preserves counts through stemming, compaction, destroy and recreation', async () => {
    expect(await database('count-compaction-destroy').countLifecycleProbe()).toEqual({
      count: 1,
      oracle: 1,
      recreated: 0,
    });
  });
  it.each([true, false])('updates a migrated stale winner with new_edits=%s', async (newEdits) => {
    expect(
      await database(`count-migrated-conflict-${newEdits}`).migratedConflictProbe(newEdits)
    ).toEqual({ before: 1, after: 1, all: 1 });
  });
  it('serializes writes through two handles', async () => {
    expect(await database('count-concurrent').concurrentCountProbe()).toEqual({
      first: 20,
      second: 20,
      oracle: 20,
    });
  });
  it('counts purge of losing, winning and deleted leaves exactly', async () => {
    const db = database('count-purge-leaves');
    await db.bulkDocs(
      [
        { _id: 'a', _rev: '1-z' },
        { _id: 'a', _rev: '1-b' },
      ],
      { new_edits: false }
    );
    await db.purge('a', '1-b');
    await exact(db, 1);
    await db.bulkDocs([{ _id: 'a', _rev: '1-c', _deleted: true }], { new_edits: false });
    await db.purge('a', '1-z');
    await exact(db, 0);
    await db.purge('a', '1-c');
    await exact(db, 0);
  });
  it('keeps attachment failures and local-only batches count-neutral', async () => {
    expect(await database('count-attachment-failure').attachmentFailureProbe()).toEqual({
      rejected: true,
      count: 1,
      oracle: 1,
    });
  });
  it('preserves totals for key, range, limit and sequence queries', async () => {
    const db = database('count-query-options');
    await db.bulkDocs([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);
    const b = await db.get('b');
    await db.remove('b', b._rev);
    for (const options of [
      { keys: [] },
      { keys: ['a', 'b', 'missing', 'a'] },
      { startkey: 'b', endkey: 'z', limit: 1 },
      { limit: 0 },
      { update_seq: true },
    ]) {
      const all = await db.allDocs(options);
      expect(all.total_rows).toBe(2);
      if ('update_seq' in options) expect(all.update_seq).toBe(4);
    }
    const keyed = await db.allDocs({ keys: ['b', 'missing'] });
    expect(keyed.rows[0].value).toMatchObject({ deleted: true });
    expect(keyed.rows[1]).toMatchObject({ error: 'not_found' });
  });
  it.each(['migration', 'migration-legacy', 'migration-existing', 'migration-null'])(
    'migrates populated %s metadata',
    async (kind) => {
      const db = database(`count-${kind}`);
      await db.bulkDocs([{ _id: 'a' }, { _id: 'b' }, { _id: '_local/x' }]);
      expect((await db.countProbe(kind)).doc_count).toBe(2);
    }
  );
  it.each(['future', 'missing', 'duplicate', 'unsafe', 'missing-count', 'fraction'])(
    'rejects %s metadata',
    async (kind) => {
      expect(await database(`count-invalid-${kind}`).countProbe(kind)).toEqual({ rejected: true });
    }
  );
  it.each([10, 100, 1000])(
    'measures bounded count reads for %s documents',
    async (size) => {
      for (const [depth, deleted] of [
        [1, 0],
        [3, 0.3],
      ]) {
        const metrics = (await database(`count-bench-${size}-${depth}`).measuredCounts(
          size,
          depth,
          deleted
        )) as any;
        expect({ size, depth, deleted, metrics }).toMatchSnapshot();
        expect(metrics.info.reads).toBeLessThanOrEqual(3);
        expect(metrics.limit0.reads).toBeLessThanOrEqual(2);
        expect(metrics.update.updates).toBe(0);
        expect(metrics.netZero.updates).toBe(0);
        expect(metrics.create.updates).toBe(1);
      }
    },
    60000
  );
});
