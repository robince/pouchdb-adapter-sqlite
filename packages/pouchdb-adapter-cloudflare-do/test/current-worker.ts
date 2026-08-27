import { DurableObject } from 'cloudflare:workers';
// Generated ESM from the user's current PouchDB checkout. Its monorepo does
// not publish declarations for these build artefacts.
// @ts-ignore
import CurrentPouchDB from '../../../../pouchdb/packages/node_modules/pouchdb-core/lib/index.es.js';

import cloudflareDOAdapter from '../src';

CurrentPouchDB.plugin(cloudflareDOAdapter);

interface Env {
  CURRENT_POUCH_DATABASE: DurableObjectNamespace<CurrentPouchDatabase>;
}

export class CurrentPouchDatabase extends DurableObject<Env> {
  private readonly db: any;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new CurrentPouchDB('db', {
      adapter: 'sqlite',
      sqliteImplementation: 'cloudflare-do',
      durableObjectStorage: ctx.storage,
    });
  }

  async lifecycle(): Promise<{ value: number; docCount: number; updateSeq: number | string }> {
    await this.db.put({ _id: 'current-core', value: 1 });
    const document = await this.db.get('current-core');
    await this.db.put({ ...document, value: 2 });
    const updated = await this.db.get('current-core');
    const info = await this.db.info();
    return { value: updated.value, docCount: info.doc_count, updateSeq: info.update_seq };
  }
}

export default { fetch: () => new Response('current PouchDB adapter test') };
