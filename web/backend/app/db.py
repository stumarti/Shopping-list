import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from .catalog import CATEGORIES

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
    # 5: aisles you can rename, reorder, add and remove (seeded from CATEGORIES; "key" remembers which starter
    #    aisle a row began as, so aisle guesses still land in the right place after a rename), and barcodes
    #    found by searching the public databases
    """
    CREATE TABLE aisles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX aisles_name ON aisles (lower(name));
    ALTER TABLE catalog ADD COLUMN barcode_source TEXT NOT NULL DEFAULT '';
    ALTER TABLE catalog ADD COLUMN barcode_checked_at TEXT NOT NULL DEFAULT ''
    """,
    # 6: no starter items any more; common items come from what you add, import or upload
    """
    DELETE FROM catalog WHERE custom = 0
    """,
    # 7: items taken off the next shop (they come back for the shop after)
    """
    CREATE TABLE shop_skips (
        catalog_id INTEGER NOT NULL REFERENCES catalog (id) ON DELETE CASCADE,
        shop_date TEXT NOT NULL,
        PRIMARY KEY (catalog_id, shop_date)
    )
    """,
    # 8: generic items ("Broccoli" holding "Tenderstem broccoli" and "Broccoli florets"), pick-one sets
    #    ("Protein": chicken or mince or salmon) and calories per pack. kind is 'item', 'group' (a generic item
    #    with kinds under it) or 'or' (a pick-one set, never bought itself). auto_group marks a generic item made
    #    only to hold kinds, so it goes again when its last kind leaves. shop_choices: the option picked from a
    #    set for one shop.
    """
    ALTER TABLE catalog ADD COLUMN kind TEXT NOT NULL DEFAULT 'item';
    ALTER TABLE catalog ADD COLUMN group_id INTEGER REFERENCES catalog (id) ON DELETE SET NULL;
    ALTER TABLE catalog ADD COLUMN or_id INTEGER REFERENCES catalog (id) ON DELETE SET NULL;
    ALTER TABLE catalog ADD COLUMN auto_group INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog ADD COLUMN kcal REAL;
    CREATE TABLE shop_choices (
        or_id INTEGER NOT NULL REFERENCES catalog (id) ON DELETE CASCADE,
        shop_date TEXT NOT NULL,
        catalog_id INTEGER NOT NULL REFERENCES catalog (id) ON DELETE CASCADE,
        PRIMARY KEY (or_id, shop_date)
    )
    """,
    # 9: macros per pack (grams of protein, carbohydrate and fat) beside the calories, and the food pyramid shelf
    #    you set for an item ("" until you do: it's guessed from the name and aisle)
    """
    ALTER TABLE catalog ADD COLUMN protein REAL;
    ALTER TABLE catalog ADD COLUMN carbs REAL;
    ALTER TABLE catalog ADD COLUMN fat REAL;
    ALTER TABLE catalog ADD COLUMN food_group TEXT NOT NULL DEFAULT '';
    """,
    # 10: items you want exactly as they are: never swapped for a cheaper or in-stock alternative
    """
    ALTER TABLE catalog ADD COLUMN exact INTEGER NOT NULL DEFAULT 0;
    """,
    # 11: what Claude in Chrome said it put in the basket, pasted back to check nothing was missed. raw keeps the
    #     reply as pasted; unreported lists the shop's items it didn't mention. link_saved marks a product link
    #     saved from it; kept marks a swap kept as the product to buy from now on.
    """
    CREATE TABLE basket_checks (
        id INTEGER PRIMARY KEY,
        store TEXT NOT NULL,
        shop_date TEXT,
        raw TEXT NOT NULL,
        total TEXT NOT NULL DEFAULT '',
        unreported TEXT NOT NULL DEFAULT '[]',
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE basket_check_items (
        id INTEGER PRIMARY KEY,
        check_id INTEGER NOT NULL REFERENCES basket_checks (id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        status TEXT NOT NULL,
        product TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        qty REAL,
        note TEXT NOT NULL DEFAULT '',
        catalog_id INTEGER REFERENCES catalog (id) ON DELETE SET NULL,
        link_saved INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0
    );
    """,
    # 12: when calories and macros were last looked up in Open Food Facts by barcode ('' for never), so filling
    #     every item doesn't ask again about ones it found nothing for
    """
    ALTER TABLE catalog ADD COLUMN nutrition_checked_at TEXT NOT NULL DEFAULT '';
    """,
]

FALLBACK_AISLE = "Other"


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
        self._seed_aisles()

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

    def _seed_aisles(self):
        if self.conn.execute("SELECT count(*) FROM aisles").fetchone()[0]:
            return
        with self.tx() as conn:
            for n, name in enumerate(CATEGORIES):
                conn.execute("INSERT INTO aisles (name, key, position) VALUES (?, ?, ?)", (name, name, n))

    def aisle_names(self) -> list[str]:
        return [r["name"] for r in self.rows("SELECT name FROM aisles ORDER BY position, id")]

    def fallback_aisle(self) -> str:
        """Where things go when their aisle is unknown or removed: the aisle that began as "Other"."""
        rows = self.rows("SELECT name FROM aisles WHERE key = ?", (FALLBACK_AISLE,))
        return rows[0]["name"] if rows else FALLBACK_AISLE

    def aisle(self, name: str | None) -> str:
        """The aisle called this (any case), or the fallback."""
        if name:
            rows = self.rows("SELECT name FROM aisles WHERE lower(name) = lower(?)", (name,))
            if rows:
                return rows[0]["name"]
        return self.fallback_aisle()

    def aisle_for_key(self, key: str) -> str:
        """A starter aisle's current name (after any rename), or the fallback if it's been removed."""
        rows = self.rows("SELECT name FROM aisles WHERE key = ?", (key,))
        return rows[0]["name"] if rows else self.aisle(key)

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


def category_order(category: str, order: list[str]) -> int:
    return order.index(category) if category in order else len(order)
