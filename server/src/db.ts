import Database from "better-sqlite3";
import { DEFAULT_SECTIONS } from "./sections.js";

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      section_id TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'text',
      barcode TEXT,
      added_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS products (
      barcode TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      section_id TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const count = db.prepare("SELECT COUNT(*) AS n FROM sections").get() as { n: number };
  if (count.n === 0) {
    const insert = db.prepare("INSERT INTO sections (id, name, color, position, updated_at) VALUES (?, ?, ?, ?, 0)");
    DEFAULT_SECTIONS.forEach((s, i) => insert.run(s.id, s.name, s.color, i));
  }
  return db;
}
