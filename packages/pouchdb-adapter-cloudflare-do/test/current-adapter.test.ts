import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { CurrentPouchDatabase } from './current-worker';

describe('current ../pouchdb core compatibility', () => {
  it('runs the Cloudflare SQLite adapter directly', async () => {
    const namespace = (env as unknown as {
      CURRENT_POUCH_DATABASE: DurableObjectNamespace<CurrentPouchDatabase>;
    }).CURRENT_POUCH_DATABASE;
    expect(await namespace.getByName('current-core').lifecycle()).toEqual({
      value: 2,
      docCount: 1,
      updateSeq: 2,
    });
  });
});
