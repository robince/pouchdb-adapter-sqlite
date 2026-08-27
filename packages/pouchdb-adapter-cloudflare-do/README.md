# pouchdb-adapter-cloudflare-do

PouchDB storage backed by the private SQLite database attached to a Cloudflare
Durable Object.

Each PouchDB database should live in one SQLite-backed Durable Object. Install
the plugin once at module scope, then pass that object's `ctx.storage` when the
database is constructed:

```ts
import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';
import cloudflareDOAdapter from 'pouchdb-adapter-cloudflare-do';

PouchDB.plugin(cloudflareDOAdapter);

export class PouchDatabase extends DurableObject<Env> {
  private readonly db: PouchDB.Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PouchDB('db', {
      adapter: 'sqlite',
      sqliteImplementation: 'cloudflare-do',
      durableObjectStorage: ctx.storage,
    } as any);
  }
}
```

The Durable Object class must use SQLite storage (`new_sqlite_classes` in a
Wrangler migration). The implementation automatically disables the core's
process-wide handle cache because a Workers isolate can host several Durable
Object instances with identically named PouchDB databases.

`npm test` runs the standalone workerd suite with PouchDB 9. In this workspace,
`npm run test:current-pouchdb` additionally loads the built `../pouchdb`
checkout and exercises this adapter directly against its current core.
