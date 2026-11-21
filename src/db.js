import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const filesDir = path.join(config.dataDir, 'files');
export const tmpDir = path.join(config.dataDir, 'tmp');
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'drophub.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('drop','send')),
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','used','revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_size INTEGER,
  pw_hash TEXT,
  locked_at INTEGER,
  used_at INTEGER,
  used_ip TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`);

// Deletes a file from disk without throwing if it is already gone.
export function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}
