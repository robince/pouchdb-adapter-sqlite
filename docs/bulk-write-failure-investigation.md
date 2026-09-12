# Bulk-write failure investigation

The failure reported by the LiveSync multi-vault PoC is an adapter bug in the
pinned `@robince/pouchdb-adapter-sqlite-core@1.1.2-cloudflare-do.0`. The current
checkout already contains its error-propagation fix in commit
`2db814fc2285cf8b6e3b11e0c2abb829b7d838ee` (merged through PR #2). No additional
transaction change is required for that exact failure. The regression also
exposed a diagnostic issue in current code: repeated SQLite error normalization
replaces the original reason with `unknown`. This investigation fixes that
diagnostic issue by preserving an already-normalized SQLite error.

The source report is `docs/bulk-write-failure-investigation.md` on the sibling
application's `multivault-poc` worktree at baseline `ee04b47`. Its original
unnamespaced reproducer lets the first document metadata INSERT execute, then
throws before returning the cursor. The public bulk request rejects, but both
documents remain readable.

## Why the old version commits and then rejects

The pinned core bridges `writeDoc()` to PouchDB's `processDocs()` with:

```js
writeDoc(...).then(() => callback(), callback)
```

That callback is `processDocs`'s argumentless `docWritten` continuation; it does
not propagate an error. Consequently:

1. The first metadata INSERT executes, then the injected exception rejects
   `writeDoc()` before it fills `results[0]`.
2. The rejection handler invokes `docWritten(error)`, which counts the document
   as complete. The promise chain recovers and writes the second document.
3. `processDocs` reports completion and the storage transaction commits.
4. PouchDB decorates the results with IDs. Accessing `res[0].id` throws because
   the adapter left that result slot empty.
5. The adapter's public callback wrapper converts this later exception into the
   error returned to the caller.

The public rejection therefore does not represent the original transaction
failing to roll back. The original write error never reached that transaction.

## Existing fix and intended behavior

Current `bulkDocs.ts` invokes the continuation only on success and forwards a
write-chain rejection to the promise awaited by the transaction. The chain
stays rejected, so subsequent queued regular-document writes cannot execute.
Change notification also happens after successful transaction completion.

For the tested fatal metadata-write exception, the entire adapter transaction
must roll back, the bulk request must reject with the injected failure reason,
and later requests must remain usable. Ordinary per-document revision conflicts
remain result rows: other valid documents in the same batch can commit.

## Historical runtime evidence

The original application characterization passed all three pinned-version cases
(unnamespaced, namespaced, and concurrent neighbour). These tests assert the
undesirable persisted outcome. A temporary unnamespaced trace additionally
recorded the first metadata INSERT, the injected throw, the second metadata
INSERT, successful transaction callback completion, successful storage
transaction completion, and only then public rejection. Reads returned
`failed1,failed2` and `doc_count: 2`.

The logged exception was `TypeError: Cannot read properties of undefined
(reading 'id')` from PouchDB's result processing. The tracing harness was removed;
the original application characterization was preserved.

## Regression coverage and validation

The permanent workerd regression in `test/adapter.test.ts` and its
`bulkFailureProbe` Worker helper retains the original after-first-metadata-INSERT
fault. It asserts that injection occurred, the public error retains the injected
reason, physical document and sequence rows and the persisted count roll back,
both failed IDs return 404, and `allDocs`, `info` and `changes` agree. A subsequent
write through the same handle succeeds with sequence 1 and appears in the feed.
The companion mixed-result test checks a 409 conflict alongside a successful
new document, preserving the original document's value.

Before the diagnostic fix, the new public regression failed only on the error
reason (`unknown` instead of the injected reason); rollback and follow-up state
matched. `handleSQLiteError` now preserves errors it has already normalized,
including when forwarding through the outer callback. A core unit test covers
repeated normalization.

Final validation: 41 core tests and 50 workerd adapter tests passed. Core build,
Cloudflare adapter TypeScript check, and ESLint on changed TypeScript files
passed. Tests used the root Vitest executable from each package directory;
workerd required localhost listeners outside the default sandbox. This is the
repository's PouchDB 9 adapter suite, not the entire upstream PouchDB suite.

## Scope and release implications

The application using the old pinned package needs a package containing the
existing fix, followed by its own dependency and lockfile update and regression
run. Package publication and application adoption are separate work; this
investigation does not publish or deploy anything.

This result does not establish behavior under process crashes, eviction, every
native SQLite error, or concurrent SQL namespaces. It does not demonstrate a
LiveSync data-loss incident. One separate code path still recovers an exception
after a successful by-sequence INSERT when it finds that revision's row; that
behavior is outside the metadata-failure diagnosis and should not be described
as universal rollback for all injected exceptions.
