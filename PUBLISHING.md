# Publishing the Cloudflare Durable Object prerelease

The branch publishes two public packages under the `@robince` npm scope at the
coordinated prerelease version `1.1.2-cloudflare-do.0`:

- `@robince/pouchdb-adapter-sqlite-core`
- `@robince/pouchdb-adapter-cloudflare-do`

The adapter pins the core to that exact version. Publish the core first so the
adapter dependency is already available when npm accepts the second package.
Its dependency uses an npm alias, so the implementation continues to import
`pouchdb-adapter-sqlite-core` while npm installs the scoped fork. A root Yarn
resolution points that same import name at the local core workspace during
development and tests.

## Verify

```sh
yarn install --immutable
yarn test
npm pack --dry-run ./packages/pouchdb-adapter-sqlite-core
npm pack --dry-run ./packages/pouchdb-adapter-cloudflare-do
```

## Authenticate

```sh
npm login
npm whoami
```

The authenticated npm account must own the `@robince` scope.

## Publish

```sh
npm publish ./packages/pouchdb-adapter-sqlite-core --access public --tag cloudflare-do
npm publish ./packages/pouchdb-adapter-cloudflare-do --access public --tag cloudflare-do
```

The package manifests also set `access` to `public` and the dist-tag to
`cloudflare-do`, keeping this prerelease away from the `latest` tag.

Consumers should pin the adapter exactly:

```sh
npm install --save-exact @robince/pouchdb-adapter-cloudflare-do@1.1.2-cloudflare-do.0
```
