# @robince/pouchdb-adapter-cloudflare-do

PouchDB storage backed by the private SQLite database attached to a Cloudflare
Durable Object.

Each PouchDB database should live in one SQLite-backed Durable Object. Install
the plugin once at module scope, then pass that object's `ctx.storage` when the
database is constructed:

```sh
npm install --save-exact @robince/pouchdb-adapter-cloudflare-do@1.1.2-cloudflare-do.0
```

```ts
import { DurableObject } from 'cloudflare:workers';
import PouchDB from 'pouchdb-core';
import cloudflareDOAdapter, { cloudflareDOOptions } from '@robince/pouchdb-adapter-cloudflare-do';

PouchDB.plugin(cloudflareDOAdapter);

export class PouchDatabase extends DurableObject<Env> {
  private readonly db: PouchDB.Database;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new PouchDB('db', cloudflareDOOptions(ctx.storage));
  }
}
```

The Durable Object class must use SQLite storage (`new_sqlite_classes` in a
Wrangler migration). The implementation automatically disables the core's
process-wide handle cache because a Workers isolate can host several Durable
Object instances with identically named PouchDB databases. It also tells the
core to keep SQL statements within Durable Object storage's 100-parameter
binding limit; other implementations retain the core's 999-parameter default.

`yarn workspace @robince/pouchdb-adapter-cloudflare-do test` runs the standalone
workerd suite with PouchDB 9.
