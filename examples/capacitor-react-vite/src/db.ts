import {Capacitor} from '@capacitor/core';
import PouchDB from 'pouchdb';
import capacitorSQLiteAdapter from 'pouchdb-adapter-capacitor-sqlite';
import sqlitePlugin from 'pouchdb-adapter-sqlite-core';
import { escapeBlob, unescapeBlob } from 'pouchdb-adapter-sqlite-core';
import { OpenConfig } from 'pouchdb-adapter-sqlite-core/interface';

const DB = PouchDB.plugin(sqlitePlugin).plugin(capacitorSQLiteAdapter);

const config: OpenConfig = {
  adapter: 'sqlite',
  sqliteImplementation: 'capicator',
  serializer: {
    serialize: async (data) => {
      return escapeBlob(data);
    },
    deserialize: async (data) => {
      return unescapeBlob(data);
    },
  },
};

export let db: PouchDB.Database;

// use browser pouchdb if we're on web, otherwise use capacitor-sqlite
if (Capacitor.getPlatform() === 'web') {
  db = new PouchDB('capp2');
} else {
  db = new DB('capp2', config);
}

export const storeDocument = async (doc: any) => {
  try {
    const response = await db.put(doc);
    console.log('Document stored successfully:', response);
  } catch (error) {
    console.error('Error storing document:', error);
  }
};

export const getAllDocuments = async () => {
  try {
    const result = await db.allDocs({ include_docs: true, attachments: true, binary: true });
    return result.rows.map((row) => row.doc);
  } catch (error) {
    console.error('Error retrieving documents:', error);
    return [];
  }
};

