'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'vault.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      display_name TEXT,
      nick TEXT,
      nick_key TEXT,
      group_name TEXT,
      banned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, provider_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_nick_key ON users(nick_key);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      code TEXT PRIMARY KEY,
      pending TEXT NOT NULL UNIQUE,
      provider TEXT,
      provider_id TEXT,
      display_name TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS puzzles (
      id INTEGER PRIMARY KEY,
      num INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      opens_at INTEGER NOT NULL,
      max_points INTEGER NOT NULL DEFAULT 100,
      min_points INTEGER NOT NULL DEFAULT 30,
      decay_minutes INTEGER NOT NULL DEFAULT 720,
      answers TEXT NOT NULL DEFAULT '[]',
      hints TEXT NOT NULL DEFAULT '[]',
      published INTEGER NOT NULL DEFAULT 0,
      notified_soon INTEGER NOT NULL DEFAULT 0,
      notified_open INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      answer TEXT NOT NULL,
      correct INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_up ON attempts(user_id, puzzle_id);
    CREATE TABLE IF NOT EXISTS solves (
      user_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      solved_at INTEGER NOT NULL,
      points INTEGER NOT NULL,
      place INTEGER NOT NULL,
      PRIMARY KEY (user_id, puzzle_id)
    );
    CREATE TABLE IF NOT EXISTS hint_uses (
      user_id INTEGER NOT NULL,
      puzzle_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, puzzle_id, idx)
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

module.exports = { openDb };
