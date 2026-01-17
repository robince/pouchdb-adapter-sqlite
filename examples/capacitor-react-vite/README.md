# React + Capacitor - Example PouchDB SQLite App

This example shows the use of the pouchdb-adaptor-sqlite plugin in a simple
React application wrapped with Capacitor.

The example implements a simple list manager, with list items stored in a PouchDB.

The database is initialised in src/db.ts, SQLite is only used on mobile platforms
for simplicity.

To build:

```shell
yarn build
```

Sync to Android/IOS, then open the project to build the app:

```shell
npx cap sync
npx cap open android
```
