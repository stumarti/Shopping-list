import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from .catalog import CATEGORIES, COMMON_ITEMS

SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    custom INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_name ON catalog (lower(name));

CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


MIGRATIONS = [
    # 1: barcodes on common items and list items
    """
    ALTER TABLE catalog ADD COLUMN barcode TEXT NOT NULL DEFAULT '';
    ALTER TABLE list_items ADD COLUMN barcode TEXT NOT NULL DEFAULT ''
    """,
    # 2: the exact product to buy at each store, saved per common item
    """
    CREATE TABLE store_products (
        catalog_id INTEGER NOT NULL REFERENCES catalog (id) ON DELETE CASCADE,
        store TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        saved_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (catalog_id, store)
    )
    """,
    # 3: what was bought in past online orders, imported from the stores' order pages
    """
    CREATE TABLE purchases (
        id INTEGER PRIMARY KEY,
        store TEXT NOT NULL,
        order_ref TEXT NOT NULL,
        bought_on TEXT NOT NULL,
        catalog_id INTEGER REFERENCES catalog (id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (store, order_ref, url)
    );
    CREATE INDEX purchases_catalog ON purchases (catalog_id)
    """,
    # 4: history lines without a product link (Tesco's Clubcard data export), when exactly they were bought,
    #    the price paid per item, and where the line came from; plus every Clubcard trip and line exactly as
    #    exported, so nothing in the file is lost
    """
    CREATE TABLE purchases_new (
        id INTEGER PRIMARY KEY,
        store TEXT NOT NULL,
        order_ref TEXT NOT NULL,
        bought_on TEXT NOT NULL,
        catalog_id INTEGER REFERENCES catalog (id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL DEFAULT '',
        bought_at TEXT NOT NULL DEFAULT '',
        unit_price REAL,
        source TEXT NOT NULL DEFAULT 'order',
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (store, order_ref, name, url)
    );
    INSERT INTO purchases_new (id, store, order_ref, bought_on, catalog_id, name, qty, url, bought_at, imported_at)
        SELECT id, store, order_ref, bought_on, catalog_id, name, qty, url, bought_on, imported_at FROM purchases;
    DROP TABLE purchases;
    ALTER TABLE purchases_new RENAME TO purchases;
    CREATE INDEX purchases_catalog ON purchases (catalog_id);
    CREATE INDEX purchases_order ON purchases (store, order_ref);
    CREATE TABLE clubcard_trips (
        ref TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT '',
        basket_gross REAL,
        basket_net REAL,
        savings REAL,
        items_count INTEGER,
        raw TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE clubcard_items (
        trip_ref TEXT NOT NULL REFERENCES clubcard_trips (ref) ON DELETE CASCADE,
        line_no INTEGER NOT NULL,
        name TEXT NOT NULL,
        quantity REAL,
        weight REAL,
        price REAL,
        volume REAL,
        grocery INTEGER NOT NULL,
        raw TEXT NOT NULL,
        PRIMARY KEY (trip_ref, line_no)
    )
    """,
]


class Database:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # One shared connection. FastAPI runs sync endpoints in a thread pool, so every use goes through
        # the lock; a household's worth of traffic never notices.
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self._seed()

    def _migrate(self):
        """Add to MIGRATIONS to change the database; never edit one that has shipped."""
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for number, sql in enumerate(MIGRATIONS[version:], start=version + 1):
            with self.tx() as conn:
                # executescript would commit our transaction, so run the statements one by one.
                for statement in sql.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute(f"PRAGMA user_version = {number}")

    def _seed(self):
        if self.conn.execute("SELECT count(*) FROM catalog").fetchone()[0]:
            return
        with self.tx():
            for category, names in COMMON_ITEMS.items():
                for name in names:
                    self.conn.execute(
                        "INSERT INTO catalog (name, category) VALUES (?, ?)", (name, category)
                    )

    @contextmanager
    def tx(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def rows(self, sql: str, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]


def category_order(category: str) -> int:
    return CATEGORIES.index(category) if category in CATEGORIES else len(CATEGORIES)
