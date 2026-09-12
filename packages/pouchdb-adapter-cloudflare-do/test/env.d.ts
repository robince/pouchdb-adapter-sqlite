import type { PouchDatabase } from './worker';

interface Env {
  POUCH_DATABASE: DurableObjectNamespace<PouchDatabase>;
}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
