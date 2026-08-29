import SQLitePlugin from 'pouchdb-adapter-sqlite-core';
import type { SQLiteImplementationFactory } from 'pouchdb-adapter-sqlite-core/interface';

import { openCloudflareDODatabase } from './cloudflare-do-adapter';

export * from './cloudflare-do-adapter';

export const CLOUDFLARE_DO_IMPLEMENTATION = 'cloudflare-do';

const cloudflareDOFactory: SQLiteImplementationFactory = {
  useDatabaseCache: false,
  maxBoundParameters: 100,
  openDatabase: openCloudflareDODatabase,
};

/** Register the SQLite core and the Durable Object SQL implementation. */
export default function CloudflareDOPouchPlugin(PouchDB: any): void {
  SQLitePlugin(PouchDB);
  PouchDB.registerSQLiteImplementation(CLOUDFLARE_DO_IMPLEMENTATION, cloudflareDOFactory);
}
