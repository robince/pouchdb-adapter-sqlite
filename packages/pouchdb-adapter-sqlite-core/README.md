# PouchDB SQLite Core Adapter


Core implementation of PouchDB SQLite adapter that provides the foundation for various SQLite implementations.

## Overview

This package implements the core functionality of the PouchDB SQLite adapter, including:

## Architecture

The core adapter follows a layered design:

1. **PouchDB Adapter Interface**: Implements the standard PouchDB adapter API
2. **SQLite Abstraction Layer**: Defines interfaces for SQLite operations
3. **Implementation Bridge**: Allows specific SQLite implementations to plug in

## Installation

```bash
npm install --save-exact @robince/pouchdb-adapter-sqlite-core@1.1.2-cloudflare-do.0
# or
yarn add --exact @robince/pouchdb-adapter-sqlite-core@1.1.2-cloudflare-do.0
```

``

## Notes
This is not a standalone adapter - it requires a concrete SQLite implementation
See the [main project README](https://github.com/BingCoke/pouchdb-adapter-sqlite/) for more details on attachment handling and common issues.
