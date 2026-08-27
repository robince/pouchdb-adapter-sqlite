import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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
    expect(paged.rows.map((row) => row.id)).toEqual(
      documents.slice(5, 15).map((doc) => doc._id)
    );

    expect((await db.allDocs({ keys: [] })).rows).toEqual([]);

    const doomed = await db.get('doc-000');
    expect(await db.purge('doc-000', doomed._rev)).toMatchObject({
      ok: true,
      deletedRevs: [doomed._rev],
      documentWasRemovedCompletely: true,
    });
    expect(await db.getStatus('doc-000')).toBe(404);
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
    expect(afterPurge.update_seq).toBe(2);
    expect((await db.get('conflicted'))._rev).toBe('2-left');
    expect((await db.changes({ since: afterPurge.update_seq })).results).toEqual([]);
  });

  it('preserves PouchDB errors raised inside the purge transaction', async () => {
    expect(await database('purge-errors').rawPurgeStatus('missing', ['1-missing'])).toBe(404);
  });
});
