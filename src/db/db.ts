import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
