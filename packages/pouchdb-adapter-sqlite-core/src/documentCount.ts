import { META_STORE, DOC_STORE, BY_SEQ_STORE } from './constants';
import { TransactionalSQLiteDatabase } from './interfaces';

export function validateDocumentCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite document count');
  }
  return value;
}

export async function readDocumentCount(db: TransactionalSQLiteDatabase): Promise<number> {
  const rows = (await db.query('SELECT doc_count FROM ' + META_STORE)).values;
  if (rows?.length !== 1) throw new Error('Expected exactly one SQLite metadata row');
  return validateDocumentCount(rows[0].doc_count);
}

export async function incrementDocumentCount(db: TransactionalSQLiteDatabase, delta: number) {
  if (!Number.isSafeInteger(delta)) throw new Error('Invalid document count delta');
  if (delta === 0) return;
  const result = await db.run('UPDATE ' + META_STORE + ' SET doc_count = doc_count + ?', [delta]);
  if (result.changes?.changes !== 1) throw new Error('Expected exactly one SQLite metadata update');
  // One bounded read for nonzero batches also catches unsafe integer overflow.
  await readDocumentCount(db);
}

// Expensive full scan: initialization/migration only, never a routine read fallback.
export async function recountDocumentsForMigration(db: TransactionalSQLiteDatabase) {
  const rows = (
    await db.query(
      'SELECT COUNT(d.id) AS num FROM ' +
        DOC_STORE +
        ' d JOIN ' +
        BY_SEQ_STORE +
        ' b ON b.seq = d.winningseq WHERE b.deleted = 0'
    )
  ).values;
  return validateDocumentCount(rows?.[0]?.num);
}
