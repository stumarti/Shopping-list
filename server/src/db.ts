import Database from "better-sqlite3";
import { DEFAULT_SECTIONS } from "./sections.js";

export type DB = Database.Database;

export const HOUSEHOLD_LIST = "household";

// Each entry upgrades the schema by one version; PRAGMA user_version records how far we got.
const MIGRATIONS: Array<(db: DB) => void> = [
  // v1: single shared list
  (db) => {
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
  },
  // v2: people, per-device tokens, invites, private lists, shopping trips and purchase history
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE tokens (
        hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        device TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE invites (
        hash TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(id),
        for_user TEXT REFERENCES users(id),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT REFERENCES users(id),
        private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO lists (id, name, owner_id, private, created_at, updated_at) VALUES ('${HOUSEHOLD_LIST}', 'Shopping', NULL, 0, 0, 0);
      ALTER TABLE items ADD COLUMN list_id TEXT NOT NULL DEFAULT '${HOUSEHOLD_LIST}';
      ALTER TABLE items ADD COLUMN added_by_user TEXT;
      CREATE INDEX items_list ON items(list_id, deleted);
      CREATE TABLE trips (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        list_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        list_id TEXT NOT NULL,
        trip_id TEXT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        brand TEXT,
        size TEXT,
        qty INTEGER NOT NULL,
        section_id TEXT NOT NULL,
        barcode TEXT,
        bought_at INTEGER NOT NULL
      );
      CREATE INDEX purchases_item ON purchases(item_id);
      CREATE INDEX purchases_list_key ON purchases(list_id, name_key, bought_at);
      CREATE INDEX purchases_trip ON purchases(trip_id);
    `);
  },
  // v3: read-only price comparison between stores
  (db) => {
    db.exec(`
      CREATE TABLE price_cache (
        store TEXT NOT NULL,
        query TEXT NOT NULL,
        match_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (store, query)
      );
      CREATE TABLE price_checks (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        result TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX price_checks_list ON price_checks(list_id, started_at);
    `);
  },
  // v4: online orders (basket filling), one per person per store run
  (db) => {
    db.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        list_id TEXT NOT NULL,
        store TEXT NOT NULL,
        status TEXT NOT NULL,
        slot_kind TEXT NOT NULL,
        slot_label TEXT NOT NULL,
        basket_url TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX orders_user_list ON orders(user_id, list_id, created_at);
      CREATE TABLE order_lines (
        order_id TEXT NOT NULL REFERENCES orders(id),
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        brand TEXT,
        size TEXT,
        qty INTEGER NOT NULL,
        status TEXT NOT NULL,
        chosen_json TEXT,
        options_json TEXT,
        error TEXT,
        PRIMARY KEY (order_id, item_id)
      );
    `);
  },
];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  let version = db.pragma("user_version", { simple: true }) as number;
  // Databases created before versioning already have the v1 tables.
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'items'").get()) version = 1;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM sections").get() as { n: number };
  if (count.n === 0) {
    const insert = db.prepare("INSERT INTO sections (id, name, color, position, updated_at) VALUES (?, ?, ?, ?, 0)");
    DEFAULT_SECTIONS.forEach((s, i) => insert.run(s.id, s.name, s.color, i));
  }
}

/** Lowercased, unpunctuated name used to spot "the same thing" across purchases. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
