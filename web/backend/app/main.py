import datetime
import json
import os
from pathlib import Path

import urllib.parse

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import clubcard, nutrition, results
from .catalog import FOOD_GROUP_IDS, FOOD_GROUPS, guess_aisle, guess_food_group
from .db import Database, category_order
from .finder import BarcodeFinder
from .stats import for_next_shop, group_suggestions, item_stats, shop_plan_date, spending, typical_shop, weekly
from .lookup import STORES, Fetch, fill_link, http_fetch, is_barcode, link_templates, lookup_barcode, product_url

USERSCRIPT_NAME = "shopping-list.user.js"
USERSCRIPT_DIRS = [Path(__file__).parent.parent / "userscript", Path(__file__).parent.parent.parent / "userscript"]


def tidy_name(v: str) -> str:
    v = " ".join(v.split())
    if not v:
        raise ValueError("Name can't be empty")
    return v[0].upper() + v[1:]


def tidy_barcode(v: str) -> str:
    v = v.strip()
    if v and not is_barcode(v):
        raise ValueError("A barcode is 8 to 14 digits")
    return v


class NewCatalogItem(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    category: str = "Other"
    barcode: str = ""

    _name = field_validator("name")(tidy_name)
    _barcode = field_validator("barcode")(tidy_barcode)


class CatalogChange(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    category: str | None = None
    barcode: str | None = None
    kcal: float | None = Field(default=None, ge=0, le=100_000)  # calories per pack; send null to clear
    protein: float | None = Field(default=None, ge=0, le=10_000)  # grams per pack, likewise
    carbs: float | None = Field(default=None, ge=0, le=10_000)
    fat: float | None = Field(default=None, ge=0, le=10_000)
    food_group: str | None = None  # a FOOD_GROUPS id, or "" to go back to the guess
    exact: bool | None = None  # never swap it for a cheaper or in-stock alternative
    group: str | None = Field(default=None, max_length=80)  # the generic item this is a kind of; "" for none
    or_set: str | None = Field(default=None, max_length=80)  # the pick-one set it's in; "" for none

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        return None if v is None else tidy_name(v)

    @field_validator("barcode")
    @classmethod
    def _barcode(cls, v):
        return None if v is None else tidy_barcode(v)


class BulkCatalog(BaseModel):
    text: str = Field(max_length=20_000)
    category: str = "Other"


class StoreProduct(BaseModel):
    url: str = Field(min_length=1, max_length=500)
    title: str = Field(default="", max_length=200)


class BasketResults(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)  # Claude in Chrome's reply, pasted as it is


class LinkFromStore(StoreProduct):
    item_id: int


class OrderLine(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    qty: int = Field(default=1, ge=1, le=99)
    url: str = Field(min_length=1, max_length=500)
    price: float | None = Field(default=None, ge=0, le=10_000)  # what the line cost in total


class PastOrder(BaseModel):
    order_ref: str = Field(min_length=1, max_length=120)
    date: str = ""
    items: list[OrderLine] = Field(min_length=1, max_length=400)


class AisleName(BaseModel):
    name: str = Field(min_length=1, max_length=40)

    _name = field_validator("name")(tidy_name)


class AisleOrder(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class SetChoice(BaseModel):
    catalog_id: int | None = None  # the option picked from a pick-one set for the next shop; null to unpick


# Which option to show first in a pick-one set: the most regular habit.
BADGE_RANK = {"weekly": 0, "scheduled": 1, "unsure": 2, "added": 3}
CATALOG_COLUMNS = "id, name, category, custom, barcode, barcode_source, kind, group_id, or_id, kcal, protein, carbs, fat, food_group, exact"
MACROS = ("protein", "carbs", "fat")


class FindBarcodes(BaseModel):
    retry: bool = False  # also try items that found nothing last time


class FillNutrition(BaseModel):
    overwrite: bool = False  # replace figures you've typed too (only for one item, when you ask)


class NewListItem(NewCatalogItem):
    category: str | None = None  # left out: the common item's aisle, or Other
    qty: int = Field(default=1, ge=1, le=99)


class ListItemChange(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=99)
    done: bool | None = None
    note: str | None = Field(default=None, max_length=120)


def _sort_items(items: list[dict], order: list[str]) -> list[dict]:
    return sorted(items, key=lambda i: (category_order(i["category"], order), i["name"].lower()))


def _neg_date(iso: str | None) -> int:
    """Sort key putting the most recent date first."""
    return -datetime.date.fromisoformat(iso).toordinal() if iso else 0


def create_app(
    db_path: str | None = None,
    static_dir: str | None = None,
    fetch: Fetch = http_fetch,
    today=datetime.date.today,
    search_gap: float = 6.5,
    nutrition_gap: float = 1.0,
) -> FastAPI:
    db = Database(db_path or os.environ.get("DB_PATH", "shopping.db"))
    finder = BarcodeFinder(db, fetch, search_gap)
    filler = nutrition.NutritionFiller(db, fetch, nutrition_gap)

    def aisle(category: str | None) -> str:
        return db.aisle(category)

    def guess(title: str) -> str:
        return db.aisle_for_key(guess_aisle(title))

    def sort_items(items: list[dict]) -> list[dict]:
        return _sort_items(items, db.aisle_names())

    def imports_dir() -> Path:
        return Path(os.environ.get("IMPORTS_DIR") or Path(db.path).resolve().parent / "imports")
    app = FastAPI(title="Shopping list")

    def list_item(item_id: int) -> dict:
        rows = db.rows("SELECT * FROM list_items WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That item isn't on the list any more")
        row = rows[0]
        row["done"] = bool(row["done"])
        return row

    def products() -> dict[int, dict]:
        """{catalog id: {store: {url, title}}} for every saved store product."""
        saved: dict[int, dict] = {}
        for r in db.rows("SELECT catalog_id, store, url, title FROM store_products"):
            saved.setdefault(r["catalog_id"], {})[r["store"]] = {"url": r["url"], "title": r["title"]}
        return saved

    def with_products(items: list[dict], key=lambda i: i["id"]) -> list[dict]:
        saved = products()
        for i in items:
            i["products"] = saved.get(key(i), {})
        return items

    def food_guess(items: list[dict]) -> list[dict]:
        """Add the pyramid shelf the item's name and aisle suggest, shown until you pick one."""
        for i in items:
            i["food_group_guess"] = guess_food_group(i["name"], i["category"])
        return items

    def catalog_item(item_id: int) -> dict:
        rows = db.rows(f"SELECT {CATALOG_COLUMNS} FROM catalog WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That common item has gone")
        food_guess(rows)
        rows[0]["custom"] = bool(rows[0]["custom"])
        rows[0]["exact"] = bool(rows[0]["exact"])
        rows[0]["trips"] = trip_counts().get(item_id, 0)
        return with_products(rows)[0]

    def trip_counts() -> dict[int, int]:
        """{catalog id: how many shopping trips it was on}. A generic item counts the trips any of its kinds were
        on, and a pick-one set the trips any of its options were on."""
        cat = {r["id"]: r for r in db.rows("SELECT id, group_id, or_id FROM catalog")}
        trips: dict[int, set] = {}
        for p in db.rows("SELECT DISTINCT catalog_id, store, order_ref FROM purchases WHERE catalog_id IS NOT NULL"):
            item = cat.get(p["catalog_id"])
            if not item:
                continue
            root = cat.get(item["group_id"]) or item
            for i in {item["id"], root["id"], root["or_id"]} - {None}:
                trips.setdefault(i, set()).add((p["store"], p["order_ref"]))
        return {i: len(t) for i, t in trips.items()}

    def kcal_map(rows: list[dict] | None = None, field: str = "kcal") -> dict[int, float | None]:
        """{catalog id: calories per pack} (or another figure per pack: protein, carbs, fat). A generic item
        without its own figure uses the average of its kinds; a kind without one uses its generic item's."""
        rows = rows if rows is not None else db.rows(f"SELECT id, group_id, {field} FROM catalog")
        out = {r["id"]: r[field] for r in rows}
        kinds: dict[int, list[float]] = {}
        for r in rows:
            if r["group_id"] and r[field] is not None:
                kinds.setdefault(r["group_id"], []).append(r[field])
        for group_id, values in kinds.items():
            if out.get(group_id) is None:
                out[group_id] = round(sum(values) / len(values), 0 if field == "kcal" else 1)
        for r in rows:
            if r["group_id"] and out.get(r["id"]) is None:
                out[r["id"]] = out.get(r["group_id"])
        return out

    def food_groups(rows: list[dict]) -> dict[int, str]:
        """{catalog id: pyramid shelf}: the one you set, else a kind's generic item's, else the guess."""
        by_id = {r["id"]: r for r in rows}
        out = {}
        for r in rows:
            parent = by_id.get(r["group_id"]) if r["group_id"] else None
            out[r["id"]] = (r["food_group"] or (parent["food_group"] if parent else "")
                            or guess_food_group(r["name"], r["category"]))
        return out

    def set_group(conn, item_id: int, name: str):
        """Put an item under a generic item called `name` (made if it doesn't exist), or take it out ("")."""
        item = conn.execute("SELECT id, name, category, kind, or_id FROM catalog WHERE id = ?", (item_id,)).fetchone()
        if item["kind"] == "or":
            raise HTTPException(422, "A pick-one set can't go under a generic item")
        name = " ".join(name.split())
        if not name:
            conn.execute("UPDATE catalog SET group_id = NULL WHERE id = ?", (item_id,))
            return
        name = tidy_name(name)
        if conn.execute("SELECT 1 FROM catalog WHERE group_id = ?", (item_id,)).fetchone():
            raise HTTPException(409, f"{item['name']} has kinds of its own, so it can't go under another item")
        row = conn.execute("SELECT id, name, kind, group_id FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone()
        if row and row["id"] == item_id:
            raise HTTPException(422, "An item can't go under itself")
        if row and row["kind"] == "or":
            raise HTTPException(409, f"{row['name']} is a pick-one set. Choose another name for the generic item")
        if row and row["group_id"]:
            raise HTTPException(409, f"{row['name']} is itself a kind of something else")
        if row:
            group_id = row["id"]
            conn.execute("UPDATE catalog SET kind = 'group' WHERE id = ?", (group_id,))
        else:
            group_id = conn.execute(
                "INSERT INTO catalog (name, category, custom, kind, auto_group) VALUES (?, ?, 1, 'group', 1)",
                (name, item["category"]),
            ).lastrowid
        # Its place in a pick-one set passes to the generic item.
        if item["or_id"]:
            conn.execute("UPDATE catalog SET or_id = coalesce(or_id, ?) WHERE id = ?", (item["or_id"], group_id))
        conn.execute("UPDATE catalog SET group_id = ?, or_id = NULL WHERE id = ?", (group_id, item_id))

    def set_or(conn, item_id: int, name: str):
        """Put an item in the pick-one set called `name` (made if it doesn't exist), or take it out ("")."""
        item = conn.execute("SELECT id, name, category, kind, group_id FROM catalog WHERE id = ?", (item_id,)).fetchone()
        if item["kind"] == "or":
            raise HTTPException(422, "A pick-one set can't go in another set")
        name = " ".join(name.split())
        if not name:
            conn.execute("UPDATE catalog SET or_id = NULL WHERE id = ?", (item_id,))
            return
        if item["group_id"]:
            group = conn.execute("SELECT name FROM catalog WHERE id = ?", (item["group_id"],)).fetchone()["name"]
            raise HTTPException(409, f"{item['name']} is a kind of {group}. Put {group} in the set instead")
        name = tidy_name(name)
        row = conn.execute("SELECT id, name, kind FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone()
        if row and row["kind"] != "or":
            raise HTTPException(409, f"{row['name']} is already a common item. Choose another name for the set")
        or_id = row["id"] if row else conn.execute(
            "INSERT INTO catalog (name, category, custom, kind) VALUES (?, ?, 1, 'or')", (name, item["category"])
        ).lastrowid
        conn.execute("UPDATE catalog SET or_id = ? WHERE id = ?", (or_id, item_id))

    def tidy_sets(conn):
        """Remove pick-one sets with no options left, and generic items with no kinds left (one made only to hold
        kinds goes, unless something was bought under its name; any other becomes a plain item again)."""
        conn.execute("DELETE FROM catalog WHERE kind = 'or' AND id NOT IN (SELECT or_id FROM catalog WHERE or_id IS NOT NULL)")
        conn.execute(
            "DELETE FROM catalog WHERE kind = 'group' AND auto_group = 1 "
            "AND id NOT IN (SELECT group_id FROM catalog WHERE group_id IS NOT NULL) "
            "AND id NOT IN (SELECT catalog_id FROM purchases WHERE catalog_id IS NOT NULL)"
        )
        conn.execute(
            "UPDATE catalog SET kind = 'item', auto_group = 0 WHERE kind = 'group' "
            "AND id NOT IN (SELECT group_id FROM catalog WHERE group_id IS NOT NULL)"
        )

    def known_store(store: str) -> dict:
        if store not in STORES:
            raise HTTPException(404, "Unknown store")
        return STORES[store]

    def save_product(catalog_id: int, store: str, body: StoreProduct) -> dict:
        try:
            url = product_url(store, body.url)
        except ValueError as e:
            raise HTTPException(422, str(e))
        with db.tx() as conn:
            conn.execute(
                "INSERT INTO store_products (catalog_id, store, url, title) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (catalog_id, store) DO UPDATE SET url = excluded.url, title = excluded.title, "
                "saved_at = datetime('now')",
                (catalog_id, store, url, " ".join(body.title.split())),
            )
        return catalog_item(catalog_id)

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": os.environ.get("APP_VERSION", "dev")}

    @app.get("/api/categories")
    def categories():
        return db.aisle_names()

    @app.get("/api/food-groups")
    def food_group_list():
        """The food pyramid's shelves, bottom first."""
        return [{"id": i, "name": n, "advice": a} for i, n, a in FOOD_GROUPS]

    @app.get("/api/links")
    def links():
        """Where the page links to: each store's search page and the barcode directory."""
        return link_templates()

    @app.get("/api/barcode/{code}")
    async def barcode(code: str):
        code = code.strip()
        if not is_barcode(code):
            raise HTTPException(422, "A barcode is 8 to 14 digits")
        known = db.rows("SELECT name, category FROM catalog WHERE barcode = ?", (code,))
        if known:
            return {"barcode": code, **known[0], "brand": "", "quantity": "", "source": "yours"}
        try:
            found = await run_in_threadpool(lookup_barcode, code, fetch)
        except OSError:
            raise HTTPException(502, "Couldn't reach the barcode directory. Type the name instead.")
        if not found:
            raise HTTPException(404, "That barcode isn't in Open Food Facts. Type the name and it'll be remembered.")
        return {**found, "category": db.aisle_for_key(found["category"])}

    # Aisles (Settings)

    def aisle_row(aisle_id: int) -> dict:
        rows = db.rows("SELECT id, name, key FROM aisles WHERE id = ?", (aisle_id,))
        if not rows:
            raise HTTPException(404, "That aisle has gone")
        return rows[0]

    @app.get("/api/aisles")
    def list_aisles():
        counts = {r["category"]: r["n"] for r in db.rows("SELECT category, count(*) AS n FROM catalog WHERE kind != 'or' GROUP BY category")}
        fallback = db.fallback_aisle()
        return [
            {"id": r["id"], "name": r["name"], "items": counts.get(r["name"], 0), "fallback": r["name"] == fallback}
            for r in db.rows("SELECT id, name FROM aisles ORDER BY position, id")
        ]

    @app.post("/api/aisles", status_code=201)
    def add_aisle(body: AisleName):
        with db.tx() as conn:
            if conn.execute("SELECT 1 FROM aisles WHERE lower(name) = lower(?)", (body.name,)).fetchone():
                raise HTTPException(409, f"There's already an aisle called {body.name}")
            # New aisles go just before the fallback one, so "Other" stays last.
            fallback = conn.execute("SELECT position FROM aisles WHERE key = 'Other'").fetchone()
            if fallback:
                conn.execute("UPDATE aisles SET position = position + 1 WHERE position >= ?", (fallback["position"],))
                position = fallback["position"]
            else:
                position = conn.execute("SELECT coalesce(max(position), -1) + 1 FROM aisles").fetchone()[0]
            new_id = conn.execute("INSERT INTO aisles (name, position) VALUES (?, ?)", (body.name, position)).lastrowid
        return aisle_row(new_id)

    @app.patch("/api/aisles/{aisle_id}")
    def rename_aisle(aisle_id: int, body: AisleName):
        old = aisle_row(aisle_id)
        with db.tx() as conn:
            if conn.execute("SELECT 1 FROM aisles WHERE lower(name) = lower(?) AND id != ?", (body.name, aisle_id)).fetchone():
                raise HTTPException(409, f"There's already an aisle called {body.name}")
            conn.execute("UPDATE aisles SET name = ? WHERE id = ?", (body.name, aisle_id))
            # Everything in it moves with it.
            conn.execute("UPDATE catalog SET category = ? WHERE category = ?", (body.name, old["name"]))
            conn.execute("UPDATE list_items SET category = ? WHERE category = ?", (body.name, old["name"]))
        return aisle_row(aisle_id)

    @app.put("/api/aisles/order")
    def reorder_aisles(body: AisleOrder):
        known = {r["id"] for r in db.rows("SELECT id FROM aisles")}
        if set(body.ids) != known or len(body.ids) != len(known):
            raise HTTPException(422, "Send every aisle once, in the new order")
        with db.tx() as conn:
            for n, aisle_id in enumerate(body.ids):
                conn.execute("UPDATE aisles SET position = ? WHERE id = ?", (n, aisle_id))
        return list_aisles()

    @app.delete("/api/aisles/{aisle_id}")
    def remove_aisle(aisle_id: int, move_to: int | None = None):
        """Remove an aisle; its items move to move_to (or the fallback aisle)."""
        gone = aisle_row(aisle_id)
        if gone["name"] == db.fallback_aisle():
            raise HTTPException(409, f"{gone['name']} is where unsorted things go, so it can't be removed. Rename it instead.")
        target = aisle_row(move_to)["name"] if move_to else db.fallback_aisle()
        if target == gone["name"]:
            raise HTTPException(422, "Pick a different aisle to move its items to")
        with db.tx() as conn:
            conn.execute("UPDATE catalog SET category = ? WHERE category = ?", (target, gone["name"]))
            conn.execute("UPDATE list_items SET category = ? WHERE category = ?", (target, gone["name"]))
            conn.execute("DELETE FROM aisles WHERE id = ?", (aisle_id,))
        return list_aisles()

    # Finding barcodes for common items in the public databases (Settings)

    @app.post("/api/barcodes/find")
    def start_finding(body: FindBarcodes):
        return finder.start(retry=body.retry)

    @app.get("/api/barcodes/find")
    def finding_status():
        return finder.status()

    @app.post("/api/barcodes/find/stop")
    def stop_finding():
        return finder.stop()

    # Calories and macros from Open Food Facts, by barcode

    @app.post("/api/catalog/{item_id}/nutrition")
    def fill_nutrition(item_id: int, body: FillNutrition):
        """Look this item's barcode up in Open Food Facts and fill its calories and macros per pack. Only empty
        figures are filled, unless overwrite."""
        item = catalog_item(item_id)
        if not item["barcode"]:
            raise HTTPException(422, "Add or scan its barcode first")
        try:
            found = nutrition.look_up(item["barcode"], fetch)
        except OSError:
            raise HTTPException(502, "Couldn't reach Open Food Facts. Try again in a minute.")
        with db.tx() as conn:
            filled = nutrition.fill(conn, item_id, found or {}, overwrite=body.overwrite)
        return {"item": catalog_item(item_id), "found": found is not None, "filled": filled,
                "basis": found["basis"] if found else None}

    @app.post("/api/nutrition/fill")
    def start_filling(body: FindBarcodes):
        """Fill calories and macros for every item with a barcode, in the background."""
        return filler.start(retry=body.retry)

    @app.get("/api/nutrition/fill")
    def filling_status():
        return filler.status()

    @app.post("/api/nutrition/fill/stop")
    def stop_filling():
        return filler.stop()

    # Common items

    @app.get("/api/catalog")
    def get_catalog():
        items = food_guess(db.rows(f"SELECT {CATALOG_COLUMNS} FROM catalog"))
        trips = trip_counts()
        for i in items:
            i["custom"] = bool(i["custom"])
            i["exact"] = bool(i["exact"])
            i["trips"] = trips.get(i["id"], 0)
        return sort_items(with_products(items))

    @app.post("/api/catalog", status_code=201)
    def add_to_catalog(body: NewCatalogItem):
        with db.tx() as conn:
            if conn.execute("SELECT 1 FROM catalog WHERE lower(name) = lower(?)", (body.name,)).fetchone():
                raise HTTPException(409, f"{body.name} is already a common item")
            item_id = conn.execute(
                "INSERT INTO catalog (name, category, custom, barcode) VALUES (?, ?, 1, ?)",
                (body.name, aisle(body.category), body.barcode),
            ).lastrowid
        return catalog_item(item_id)

    @app.post("/api/catalog/bulk")
    def add_many_to_catalog(body: BulkCatalog):
        """One item per line. Lines already in the list (any case) are skipped."""
        added, skipped = [], []
        with db.tx() as conn:
            for line in body.text.splitlines():
                line = " ".join(line.strip(" -•*\t").split())[:80]
                if not line:
                    continue
                name = tidy_name(line)
                if conn.execute("SELECT 1 FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone():
                    skipped.append(name)
                    continue
                conn.execute(
                    "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, aisle(body.category))
                )
                added.append(name)
        return {"added": added, "skipped": skipped}

    @app.patch("/api/catalog/{item_id}")
    def change_catalog_item(item_id: int, body: CatalogChange):
        catalog_item(item_id)
        changes = body.model_dump(exclude_none=True, exclude={"kcal", *MACROS, "group", "or_set"})
        if "kcal" in body.model_fields_set:
            changes["kcal"] = None if body.kcal is None else round(body.kcal)
        for m in MACROS:
            if m in body.model_fields_set:
                value = getattr(body, m)
                changes[m] = None if value is None else round(value, 1)
        if "food_group" in changes and changes["food_group"] not in FOOD_GROUP_IDS | {""}:
            raise HTTPException(422, "That isn't a food group")
        if "category" in changes:
            changes["category"] = aisle(changes["category"])
        if "name" in changes:
            changes["custom"] = 1  # renamed by you, e.g. "Milk" → "Avonmore Milk 2L": no longer a generic starter
        if "barcode" in changes:
            # Your own barcode (or clearing one) is final: the barcode finder leaves this item alone after.
            changes["barcode_source"] = "you" if changes["barcode"] else ""
            changes["barcode_checked_at"] = datetime.datetime.now().isoformat(timespec="seconds")
            changes["nutrition_checked_at"] = ""  # a new barcode is worth looking up for calories again
        if changes:
            with db.tx() as conn:
                if "name" in changes and conn.execute(
                    "SELECT 1 FROM catalog WHERE lower(name) = lower(?) AND id != ?", (changes["name"], item_id)
                ).fetchone():
                    raise HTTPException(409, f"{changes['name']} is already a common item")
                cols = ", ".join(f"{k} = ?" for k in changes)
                conn.execute(f"UPDATE catalog SET {cols} WHERE id = ?", (*changes.values(), item_id))
        if body.group is not None or body.or_set is not None:
            with db.tx() as conn:
                if body.group is not None:
                    set_group(conn, item_id, body.group)
                if body.or_set is not None:
                    set_or(conn, item_id, body.or_set)
                tidy_sets(conn)
        return catalog_item(item_id)

    @app.post("/api/catalog/clear")
    def clear_catalog():
        """Remove every common item (and their saved store products and barcodes). The list, the purchase
        history and uploaded files stay, so "Rebuild from history" can bring items back."""
        with db.tx() as conn:
            removed = conn.execute("DELETE FROM catalog").rowcount
        finder.stop()
        filler.stop()
        return {"removed": removed}

    @app.post("/api/catalog/rebuild")
    def rebuild_catalog():
        """Make common items again from the purchase history: every product from an online order (with its store
        link), and anything else bought on at least CLUBCARD_MIN_TRIPS trips (default 2)."""
        min_trips = int(os.environ.get("CLUBCARD_MIN_TRIPS", "2"))
        added = relinked = 0
        with db.tx() as conn:
            groups = conn.execute(
                "SELECT lower(name) AS key, max(name) AS name, count(DISTINCT store || order_ref) AS trips, "
                "max(url != '') AS linked FROM purchases WHERE catalog_id IS NULL GROUP BY lower(name)"
            ).fetchall()
            for g in groups:
                if g["trips"] < min_trips and not g["linked"]:
                    continue
                name = tidy_name(g["name"][:80])
                row = conn.execute("SELECT id FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone()
                if row:
                    catalog_id = row["id"]
                else:
                    catalog_id = conn.execute(
                        "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, guess(g["name"]))
                    ).lastrowid
                    added += 1
                relinked += conn.execute(
                    "UPDATE purchases SET catalog_id = ? WHERE catalog_id IS NULL AND lower(name) = ?", (catalog_id, g["key"])
                ).rowcount
                for link in conn.execute(
                    "SELECT store, url, name FROM purchases WHERE catalog_id = ? AND url != '' ORDER BY bought_at DESC",
                    (catalog_id,),
                ).fetchall():
                    conn.execute(
                        "INSERT OR IGNORE INTO store_products (catalog_id, store, url, title) VALUES (?, ?, ?, ?)",
                        (catalog_id, link["store"], link["url"], link["name"][:200]),
                    )
        return {"added": added, "purchases": relinked}

    @app.delete("/api/catalog/{item_id}", status_code=204)
    def remove_from_catalog(item_id: int):
        with db.tx() as conn:
            conn.execute("DELETE FROM catalog WHERE id = ?", (item_id,))
            tidy_sets(conn)

    @app.put("/api/catalog/{item_id}/products/{store}")
    def set_store_product(item_id: int, store: str, body: StoreProduct):
        """Remember the exact product to buy for this item at this store."""
        known_store(store)
        catalog_item(item_id)
        return save_product(item_id, store, body)

    @app.delete("/api/catalog/{item_id}/products/{store}")
    def forget_store_product(item_id: int, store: str):
        known_store(store)
        with db.tx() as conn:
            conn.execute("DELETE FROM store_products WHERE catalog_id = ? AND store = ?", (item_id, store))
        return catalog_item(item_id)

    # The list

    def list_rows(where: str = "") -> list[dict]:
        items = db.rows(
            "SELECT l.*, c.id AS catalog_id FROM list_items l "
            f"LEFT JOIN catalog c ON lower(c.name) = lower(l.name) {where}"
        )
        for i in items:
            i["done"] = bool(i["done"])
        return sort_items(with_products(items, key=lambda i: i["catalog_id"]))

    @app.get("/api/list")
    def get_list():
        return list_rows()

    # Filling an online basket (used by the browser userscript)

    @app.get("/api/basket/{store}")
    def basket(store: str):
        """What's still to buy, with the saved product for this store where there is one."""
        info = known_store(store)
        search = link_templates()["stores"]
        template = next(s["search"] for s in search if s["id"] == store)
        items = [
            {
                "id": i["id"],
                "name": i["name"],
                "qty": i["qty"],
                "product": i["products"].get(store),
                "search": fill_link(template, i["name"]),
            }
            for i in list_rows("WHERE l.done = 0")
        ]
        return {"store": store, "name": info["name"], "items": items}

    @app.post("/api/basket/{store}/link")
    def link_from_store(store: str, body: LinkFromStore):
        """Save the product page the person is looking at for an item on their list."""
        known_store(store)
        item = list_item(body.item_id)
        with db.tx() as conn:
            known = conn.execute("SELECT id FROM catalog WHERE lower(name) = lower(?)", (item["name"],)).fetchone()
            catalog_id = known["id"] if known else conn.execute(
                "INSERT INTO catalog (name, category, custom, barcode) VALUES (?, ?, 1, ?)",
                (item["name"], item["category"], item["barcode"]),
            ).lastrowid
        return save_product(catalog_id, store, body)

    # Checking the basket: Claude in Chrome's results, pasted back

    def shop_names() -> dict[str, dict]:
        """{matching key: {name, catalog_id}} for everything on the next shop, including each option of a
        pick-one set (Claude names the one it picked)."""
        plan = next_shop()
        by_name = {r["name"].lower(): r["id"] for r in db.rows("SELECT id, name FROM catalog")}
        out: dict[str, dict] = {}
        for i in plan["items"]:
            # Named as the list shows it: a picked set by the option picked, otherwise by the set's own name.
            picked = next((o for o in i["options"] or [] if o["catalog_id"] == i["chosen"]), None)
            name = picked["name"] if picked else i["name"]
            cid = i["chosen"] if i["kind"] == "or" else (i["catalog_id"] or by_name.get(i["name"].lower()))
            out[results.key(i["name"])] = {"name": name, "catalog_id": cid}
            for o in i["options"] or []:
                out.setdefault(results.key(o["name"]), {"name": name, "catalog_id": o["catalog_id"]})
        return out

    def basket_check(store: str) -> dict | None:
        checks = db.rows("SELECT * FROM basket_checks WHERE store = ? ORDER BY id DESC LIMIT 1", (store,))
        if not checks or not checks[0]["raw"]:
            return None  # none yet, or cleared for a new order
        c = checks[0]
        items = db.rows("SELECT * FROM basket_check_items WHERE check_id = ? ORDER BY id", (c["id"],))
        for i in items:
            i["link_saved"], i["kept"] = bool(i["link_saved"]), bool(i["kept"])
        counts = {s: sum(1 for i in items if i["status"] == s) for s in ("added", "swapped", "missing")}
        return {"id": c["id"], "store": store, "shop_date": c["shop_date"], "checked_at": c["checked_at"], "total": c["total"],
                "items": items, "unreported": json.loads(c["unreported"]), "counts": counts}

    @app.post("/api/basket/{store}/check")
    def check_basket(store: str, body: BasketResults):
        """Read Claude in Chrome's results: what went in the basket, what was swapped and what's missing, plus
        anything on the shop it didn't mention. Products it added are saved for items with none saved yet."""
        known_store(store)
        try:
            parsed = results.parse(body.text)
        except ValueError as e:
            raise HTTPException(422, str(e))
        names = shop_names()
        saved = {(r["catalog_id"]) for r in db.rows("SELECT catalog_id FROM store_products WHERE store = ?", (store,))}
        reported: set[str] = set()
        plan = shop_plan()
        with db.tx() as conn:
            check_id = conn.execute(
                "INSERT INTO basket_checks (store, shop_date, raw, total) VALUES (?, ?, ?, ?)",
                (store, plan["date"] if plan else None, body.text, parsed["total"]),
            ).lastrowid
            for r in parsed["items"]:
                match = names.get(results.key(r["item"]))
                if match:
                    reported.add(match["name"])
                cid = match["catalog_id"] if match else None
                link_saved = False
                # A product it added for the item itself (not a swap) becomes the one to buy, if there isn't one yet.
                if r["status"] == "added" and cid and r["url"] and cid not in saved:
                    try:
                        url = product_url(store, r["url"])
                    except ValueError:
                        url = None
                    if url:
                        conn.execute(
                            "INSERT INTO store_products (catalog_id, store, url, title) VALUES (?, ?, ?, ?) "
                            "ON CONFLICT (catalog_id, store) DO NOTHING",
                            (cid, store, url, r["product"]),
                        )
                        saved.add(cid)
                        link_saved = True
                conn.execute(
                    "INSERT INTO basket_check_items (check_id, item, status, product, url, qty, note, catalog_id, link_saved) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (check_id, match["name"] if match else r["item"], r["status"], r["product"], r["url"], r["qty"], r["note"],
                     cid, int(link_saved)),
                )
            unreported = sorted({m["name"] for m in names.values()} - reported, key=str.lower)
            conn.execute("UPDATE basket_checks SET unreported = ? WHERE id = ?", (json.dumps(unreported), check_id))
        return basket_check(store)

    @app.get("/api/basket/{store}/check")
    def latest_basket_check(store: str):
        """The last basket check for this store, or null."""
        known_store(store)
        return basket_check(store)

    @app.delete("/api/basket/{store}/check", status_code=204)
    def clear_basket_check(store: str):
        """Start afresh for a new order (the checks stay in the database, just not shown)."""
        known_store(store)
        with db.tx() as conn:
            conn.execute(
                "INSERT INTO basket_checks (store, shop_date, raw) VALUES (?, NULL, '')", (store,)
            )

    @app.post("/api/basket/check-items/{item_id}/keep")
    def keep_swap(item_id: int):
        """Keep a swap: its product becomes the one to buy for that item from now on."""
        rows = db.rows(
            "SELECT i.*, c.store FROM basket_check_items i JOIN basket_checks c ON c.id = i.check_id WHERE i.id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That result has gone")
        r = rows[0]
        if not r["catalog_id"] or not r["url"]:
            raise HTTPException(422, "There's no product link to keep for that one")
        save_product(r["catalog_id"], r["store"], StoreProduct(url=r["url"], title=r["product"][:200]))
        with db.tx() as conn:
            conn.execute("UPDATE basket_check_items SET kept = 1 WHERE id = ?", (item_id,))
        return basket_check(r["store"])

    # Did you forget? Things you usually get that aren't on this shop

    @app.get("/api/next-shop/forgotten")
    def forgotten():
        """Before ordering: regulars (on at least half of your last 12 shops) that aren't on this shop, and things
        due before the shop after this one. Leaves out what's on the shop, a maybe, or taken off on purpose."""
        plan = shop_plan()
        if not plan:
            return {"regulars": [], "due_soon": []}
        current = next_shop()
        on = {i["name"].lower() for i in current["items"] + current["maybe"] + current["skipped"]}
        for i in current["items"]:
            on.update(o["name"].lower() for o in i["options"] or [])
        # The last 12 trips, and which items (as their generic item) were on each.
        trips = db.rows(
            "SELECT store, order_ref, max(bought_on) AS day FROM purchases GROUP BY store, order_ref ORDER BY day DESC LIMIT 12")
        recent = {(t["store"], t["order_ref"]) for t in trips}
        on_trip: dict[int, set] = {}
        for p in db.rows(
            "SELECT coalesce(c.group_id, c.id) AS root, p.store, p.order_ref FROM purchases p JOIN catalog c ON c.id = p.catalog_id"
        ):
            if (p["store"], p["order_ref"]) in recent:
                on_trip.setdefault(p["root"], set()).add((p["store"], p["order_ref"]))
        shop = datetime.date.fromisoformat(plan["date"])
        regulars, due_soon = [], []
        for u in usual_items():
            if u["name"].lower() in on:
                continue
            qty = max(1, round(u["usual_qty"] or 1))
            base = {"catalog_id": u["catalog_id"], "name": u["name"], "category": u["category"], "qty": qty}
            n = len(on_trip.get(u["catalog_id"], ()))
            if len(trips) >= 4 and n >= 3 and n * 2 >= len(trips):
                regulars.append({**base, "trips": n, "reason": f"On {n} of your last {len(trips)} shops"})
                continue
            # Due before the following shop: the next-shop window stretched to a whole gap.
            pick = for_next_shop(u, shop, plan["every_days"] * 2, today())
            if pick:
                due_soon.append({**base, "trips": u["trips"], "reason": pick["detail"]})
        regulars.sort(key=lambda r: (-r["trips"], r["name"].lower()))
        return {"regulars": regulars, "due_soon": sort_items(due_soon)}

    # Past online orders (imported by the userscript from the stores' order pages)

    @app.post("/api/history/{store}/import")
    def import_order(store: str, body: PastOrder):
        """Record a past order, and make sure each product is a common item with this store's product saved."""
        known_store(store)
        try:
            bought_on = datetime.date.fromisoformat(body.date).isoformat()
        except ValueError:
            bought_on = datetime.date.today().isoformat()
        added = new_items = skipped = 0
        with db.tx() as conn:
            for line in body.items:
                try:
                    url = product_url(store, line.url)
                except ValueError:
                    skipped += 1
                    continue
                title = " ".join(line.name.split())
                name = tidy_name(title[:80])
                saved = conn.execute(
                    "SELECT catalog_id FROM store_products WHERE store = ? AND url = ?", (store, url)
                ).fetchone()
                catalog_id = saved["catalog_id"] if saved else None
                if catalog_id is None:
                    named = conn.execute("SELECT id FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone()
                    if named:
                        catalog_id = named["id"]
                    else:
                        catalog_id = conn.execute(
                            "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, guess(title))
                        ).lastrowid
                        new_items += 1
                    conn.execute(
                        "INSERT OR IGNORE INTO store_products (catalog_id, store, url, title) VALUES (?, ?, ?, ?)",
                        (catalog_id, store, url, title[:200]),
                    )
                added += conn.execute(
                    "INSERT OR IGNORE INTO purchases "
                    "(store, order_ref, bought_on, bought_at, catalog_id, name, qty, url, unit_price) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (store, body.order_ref, bought_on, bought_on, catalog_id, title[:300], line.qty, url,
                     None if line.price is None else round(line.price / line.qty, 2)),
                ).rowcount
        return {
            "order_ref": body.order_ref,
            "bought_on": bought_on,
            "products": added,
            "new_common_items": new_items,
            "skipped": skipped,
            "already_imported": added == 0 and skipped < len(body.items),
        }

    @app.post("/api/history/tesco/clubcard")
    async def import_clubcard(request: Request):
        """Tesco's Clubcard data export, uploaded as the raw .json (or .zip) file.

        Every trip goes into the history. Products bought on at least CLUBCARD_MIN_TRIPS trips (default 2)
        also become common items, so one-off buys don't crowd the list."""
        raw = await request.body()
        if len(raw) > 200 * 1024 * 1024:
            raise HTTPException(413, "That file is over 200 MB. Upload the purchases file on its own.")
        try:
            trips, not_groceries = clubcard.parse(clubcard.load(raw))
        except ValueError as e:
            raise HTTPException(422, str(e))
        except Exception:
            raise HTTPException(422, "Couldn't read that file. Upload the file from Tesco's data download as it came.")
        if not trips:
            raise HTTPException(422, "No shopping trips found in that file. Is it the Tesco data download?")
        min_trips = int(os.environ.get("CLUBCARD_MIN_TRIPS", "2"))
        saved_as = await run_in_threadpool(keep_upload, raw)
        result = await run_in_threadpool(save_clubcard, trips, not_groceries, min_trips)
        return {**result, "saved_as": saved_as}

    def keep_upload(raw: bytes) -> str:
        """Keep the file exactly as uploaded, next to the database, so nothing in it is ever lost."""
        folder = imports_dir()
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")
        ext = "zip" if raw[:2] == b"PK" else "json"
        path = folder / f"tesco-clubcard-{stamp}.{ext}"
        n = 2
        while path.exists():
            path = folder / f"tesco-clubcard-{stamp}-{n}.{ext}"
            n += 1
        path.write_bytes(raw)
        return path.name

    def save_clubcard(trips: list, not_groceries: int, min_trips: int) -> dict:
        new_trips = lines = new_items = 0
        with db.tx() as conn:
            # Every trip and every line, exactly as exported.
            for t in trips:
                r = t.raw
                if conn.execute(
                    "INSERT OR IGNORE INTO clubcard_trips (ref, timestamp, type, basket_gross, basket_net, savings, "
                    "items_count, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (t.ref, str(r.get("timestamp", "")), str(r.get("type", "")), clubcard.number(r.get("basketValueGross")),
                     clubcard.number(r.get("basketValueNet")), clubcard.number(r.get("overallBasketSavings")),
                     clubcard.number(r.get("numberOfItems")), json.dumps(r, ensure_ascii=False)),
                ).rowcount:
                    for n, line in enumerate(i for i in r.get("items") or [] if isinstance(i, dict)):
                        name = " ".join(str(line.get("name") or "").split())
                        conn.execute(
                            "INSERT INTO clubcard_items (trip_ref, line_no, name, quantity, weight, price, volume, "
                            "grocery, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (t.ref, n, name, clubcard.number(line.get("quantity")), clubcard.number(line.get("weight")),
                             clubcard.number(line.get("price")), clubcard.number(line.get("volume")),
                             int(bool(name) and clubcard.is_grocery(name)), json.dumps(line, ensure_ascii=False)),
                        )
            done = {r["order_ref"] for r in conn.execute("SELECT DISTINCT order_ref FROM purchases WHERE store = 'tesco'")}
            fresh = [t for t in trips if t.ref not in done]
            # How many trips (in the file and already imported) each product appears on.
            counts: dict[str, int] = {}
            for t in trips:
                for name in t.lines:
                    counts[name.lower()] = counts.get(name.lower(), 0) + 1
            for r in conn.execute("SELECT lower(name) AS n, count(DISTINCT order_ref) AS c FROM purchases "
                                  "WHERE store = 'tesco' AND order_ref NOT LIKE 'clubcard:%' GROUP BY lower(name)"):
                counts[r["n"]] = counts.get(r["n"], 0) + r["c"]
            catalog_ids: dict[str, int | None] = {}

            def catalog_for(title: str) -> int | None:
                key = title.lower()
                if key in catalog_ids:
                    return catalog_ids[key]
                name = tidy_name(title[:80])
                row = conn.execute("SELECT id FROM catalog WHERE lower(name) = lower(?)", (name,)).fetchone()
                if row:
                    catalog_ids[key] = row["id"]
                elif counts.get(key, 0) >= min_trips:
                    nonlocal new_items
                    catalog_ids[key] = conn.execute(
                        "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, guess(title))
                    ).lastrowid
                    new_items += 1
                else:
                    catalog_ids[key] = None
                return catalog_ids[key]

            for t in fresh:
                new_trips += 1
                for title, line in t.lines.items():
                    lines += conn.execute(
                        "INSERT OR IGNORE INTO purchases "
                        "(store, order_ref, bought_on, bought_at, catalog_id, name, qty, unit_price, source) "
                        "VALUES ('tesco', ?, ?, ?, ?, ?, ?, ?, ?)",
                        (t.ref, t.bought_on, t.bought_at, catalog_for(title), title[:300], line["qty"],
                         line["unit_price"], "clubcard " + t.kind),
                    ).rowcount
        dates = sorted(t.bought_on for t in trips)
        return {
            "trips": len(trips),
            "new_trips": new_trips,
            "already_imported": len(trips) - new_trips,
            "lines": lines,
            "new_common_items": new_items,
            "not_groceries": not_groceries,
            "from": dates[0],
            "to": dates[-1],
        }

    def usual_items() -> list[dict]:
        """Every common item that has purchases, with its summary (how often, when next, prices)."""
        # Kinds count towards their generic item: buying tenderstem one week and florets the next is buying broccoli.
        rows = db.rows(
            "SELECT r.id AS catalog_id, r.name, r.category, p.store, p.order_ref, p.bought_on, p.qty, p.unit_price "
            "FROM purchases p JOIN catalog c ON c.id = p.catalog_id JOIN catalog r ON r.id = coalesce(c.group_id, c.id) "
            "ORDER BY p.bought_at, p.id"
        )
        by_item: dict[int, list[dict]] = {}
        for r in rows:
            by_item.setdefault(r["catalog_id"], []).append(r)
        out = []
        for catalog_id, item_rows in by_item.items():
            stats = item_stats(item_rows)
            out.append({
                "catalog_id": catalog_id,
                "name": item_rows[0]["name"],
                "category": item_rows[0]["category"],
                "orders": stats["trips"],
                **stats,
            })
        return out

    # The next shop: when, and what it needs

    def shop_plan():
        return shop_plan_date([r["d"] for r in db.rows("SELECT DISTINCT bought_on AS d FROM purchases")], today())

    @app.get("/api/next-shop")
    def next_shop():
        plan = shop_plan()
        cat = {r["id"]: r for r in db.rows(
            "SELECT id, name, category, kind, group_id, or_id, kcal, protein, carbs, fat, food_group FROM catalog")}
        by_name = {r["name"].lower(): r["id"] for r in cat.values()}
        kcal = kcal_map(list(cat.values()))
        macros = {m: kcal_map(list(cat.values()), m) for m in MACROS}
        shelves = food_groups(list(cat.values()))
        trips = trip_counts()

        def extra(catalog_id: int | None, name: str = "", category: str = "") -> dict:
            k = kcal.get(catalog_id) if catalog_id else None
            return {"trips": trips.get(catalog_id, 0) if catalog_id else 0, "kind": "item", "kcal_low": k, "kcal_high": k,
                    "options": None, "chosen": None,
                    **{m: macros[m].get(catalog_id) if catalog_id else None for m in MACROS},
                    "food_group": shelves.get(catalog_id, "") if catalog_id else guess_food_group(name, category)}

        items = []
        skipped = []
        maybe = []
        added = db.rows("SELECT id, name, category, qty FROM list_items WHERE done = 0")
        added_names = {a["name"].lower() for a in added}
        if plan:
            shop = datetime.date.fromisoformat(plan["date"])
            skips = {r["catalog_id"] for r in db.rows("SELECT catalog_id FROM shop_skips WHERE shop_date = ?", (plan["date"],))}
            usual = usual_items()
            for u in usual:
                pick = for_next_shop(u, shop, plan["every_days"], today())
                if not pick or u["name"].lower() in added_names:
                    continue
                entry = {
                    "catalog_id": u["catalog_id"], "list_item_id": None, "name": u["name"], "category": u["category"],
                    "qty": max(1, round(u["usual_qty"] or 1)), **pick, **extra(u["catalog_id"]),
                }
                (skipped if u["catalog_id"] in skips else items).append(entry)
            items, skipped = pick_one_sets(items, skipped, skips, plan["date"], cat, kcal, trips, usual, macros, shelves)
            # Things you're not sure to need stay out of the shop until you add them (a pick-one set stays in: you pick).
            maybe = [e for e in items + skipped if e["badge"] == "unsure" and e["kind"] != "or"]
            items = [e for e in items if e not in maybe]
            skipped = [e for e in skipped if e not in maybe]
        for a in added:
            items.append({
                "catalog_id": None, "list_item_id": a["id"], "name": a["name"], "category": a["category"], "qty": a["qty"],
                "badge": "added", "label": "Added", "detail": "You added this",
                **extra(by_name.get(a["name"].lower()), a["name"], a["category"]),
            })
        return {"shop": plan, "items": sort_items(items), "maybe": sort_items(maybe), "skipped": sort_items(skipped)}

    def pick_one_sets(items, skipped, skips, shop_date, cat, kcal, trips, usual, macros, shelves):
        """Fold the options of each pick-one set (two or more options) that are due into one line for the set."""
        options_of: dict[int, list[int]] = {}
        for r in cat.values():
            if r["or_id"] and not r["group_id"] and r["or_id"] in cat:
                options_of.setdefault(r["or_id"], []).append(r["id"])
        options_of = {k: v for k, v in options_of.items() if len(v) >= 2}
        if not options_of:
            return items, skipped
        set_of = {i: s for s, ids in options_of.items() for i in ids}
        due: dict[int, list[dict]] = {}
        kept = []
        for e in items:
            if e["catalog_id"] in set_of:
                due.setdefault(set_of[e["catalog_id"]], []).append(e)
            else:
                kept.append(e)
        chosen_for = {r["or_id"]: r["catalog_id"] for r in db.rows(
            "SELECT or_id, catalog_id FROM shop_choices WHERE shop_date = ?", (shop_date,))}
        usual_qty = {u["catalog_id"]: max(1, round(u["usual_qty"] or 1)) for u in usual}
        for set_id, entries in due.items():
            best = min(entries, key=lambda e: (BADGE_RANK.get(e["badge"], 9), -e["trips"]))
            due_ids = {e["catalog_id"] for e in entries}
            options = [
                {"catalog_id": i, "name": cat[i]["name"], "trips": trips.get(i, 0), "due": i in due_ids,
                 "qty": usual_qty.get(i, 1), "kcal": kcal.get(i)}
                for i in sorted(options_of[set_id], key=lambda i: (-trips.get(i, 0), cat[i]["name"].lower()))
            ]
            chosen = next((o for o in options if o["catalog_id"] == chosen_for.get(set_id)), None)
            known = [o["kcal"] for o in options if o["kcal"] is not None]
            entry = {
                "catalog_id": set_id, "list_item_id": None, "name": cat[set_id]["name"], "category": cat[set_id]["category"],
                "qty": chosen["qty"] if chosen else best["qty"], "badge": best["badge"], "label": best["label"],
                "detail": best["detail"] if len(entries) == 1 else f"{len(entries)} of these are due",
                "trips": trips.get(set_id, 0), "kind": "or", "options": options,
                "chosen": chosen["catalog_id"] if chosen else None,
                "kcal_low": chosen["kcal"] if chosen else (min(known) if known else None),
                "kcal_high": chosen["kcal"] if chosen else (max(known) if known else None),
            }
            # Macros and shelf: the one picked, or until then the average of the options (the most bought's shelf).
            for m in MACROS:
                values = [macros[m].get(o["catalog_id"]) for o in options]
                values = [v for v in values if v is not None]
                entry[m] = (macros[m].get(chosen["catalog_id"]) if chosen
                            else round(sum(values) / len(values), 1) if values else None)
            entry["food_group"] = shelves.get(chosen["catalog_id"] if chosen else options[0]["catalog_id"], "")
            (skipped if set_id in skips else kept).append(entry)
        return kept, skipped

    @app.post("/api/next-shop/choose/{or_id}")
    def choose_for_next_shop(or_id: int, body: SetChoice):
        """Pick one option from a pick-one set for the next shop (or unpick it)."""
        if catalog_item(or_id)["kind"] != "or":
            raise HTTPException(422, "That isn't a pick-one set")
        plan = shop_plan()
        if not plan:
            raise HTTPException(409, "There's no next shop planned yet")
        with db.tx() as conn:
            if body.catalog_id is None:
                conn.execute("DELETE FROM shop_choices WHERE or_id = ? AND shop_date = ?", (or_id, plan["date"]))
            else:
                if not conn.execute("SELECT 1 FROM catalog WHERE id = ? AND or_id = ?", (body.catalog_id, or_id)).fetchone():
                    raise HTTPException(422, "That isn't one of the set's options")
                conn.execute(
                    "INSERT INTO shop_choices (or_id, shop_date, catalog_id) VALUES (?, ?, ?) "
                    "ON CONFLICT (or_id, shop_date) DO UPDATE SET catalog_id = excluded.catalog_id",
                    (or_id, plan["date"], body.catalog_id),
                )
            conn.execute("DELETE FROM shop_choices WHERE shop_date < ?", (today().isoformat(),))
        return next_shop()

    @app.get("/api/typical-shop")
    def typical():
        """What a typical shop looks like, aisle by aisle, over the last year of trips (or all of them)."""
        query = (
            "SELECT p.store || '|' || p.order_ref AS trip, p.bought_on, p.name, p.qty, p.unit_price, p.catalog_id, "
            "r.name AS root_name, r.category AS root_category FROM purchases p "
            "LEFT JOIN catalog c ON c.id = p.catalog_id LEFT JOIN catalog r ON r.id = coalesce(c.group_id, c.id)"
        )
        since = (today() - datetime.timedelta(days=365)).isoformat()
        rows = db.rows(query + " WHERE p.bought_on >= ?", (since,)) or db.rows(query)
        kcal = kcal_map()
        lines = []
        for r in rows:
            k = kcal.get(r["catalog_id"]) if r["catalog_id"] else None
            lines.append({
                "trip": r["trip"],
                "day": r["bought_on"],
                "aisle": r["root_category"] or guess(r["name"]),
                "name": r["root_name"] or r["name"],
                "qty": r["qty"],
                "spend": r["unit_price"] * r["qty"] if r["unit_price"] is not None else None,
                "kcal": k * r["qty"] if k is not None else None,
            })
        out = typical_shop(lines, db.aisle_names())
        if out:
            days = sorted(r["bought_on"] for r in rows)
            out.update({"from": days[0], "to": days[-1]})
        return out

    @app.post("/api/next-shop/skip/{catalog_id}")
    def skip_for_next_shop(catalog_id: int):
        """Take an item off the next shop. It's back for the one after."""
        catalog_item(catalog_id)
        plan = shop_plan()
        if not plan:
            raise HTTPException(409, "There's no next shop planned yet")
        with db.tx() as conn:
            conn.execute("INSERT OR IGNORE INTO shop_skips (catalog_id, shop_date) VALUES (?, ?)", (catalog_id, plan["date"]))
            conn.execute("DELETE FROM shop_skips WHERE shop_date < ?", (today().isoformat(),))
        return next_shop()

    @app.delete("/api/next-shop/skip/{catalog_id}")
    def unskip_for_next_shop(catalog_id: int):
        with db.tx() as conn:
            conn.execute("DELETE FROM shop_skips WHERE catalog_id = ?", (catalog_id,))
        return next_shop()

    @app.get("/api/history")
    def history():
        """Imported orders, newest first, and the items bought most often."""
        orders = db.rows(
            "SELECT store, order_ref, bought_on, count(*) AS products, sum(qty) AS units, max(source) AS source "
            "FROM purchases GROUP BY store, order_ref ORDER BY bought_on DESC, order_ref"
        )
        usual = usual_items()
        usual.sort(key=lambda u: (-u["orders"], _neg_date(u["last_bought"]), u["name"]))
        return {"orders": orders, "usual": usual[:40], "suggestions": group_suggestions(usual, today())}

    @app.get("/api/history/items/{catalog_id}")
    def item_history(catalog_id: int):
        """Every time this item was bought, oldest first, with what it cost, plus the summary.

        Timing is worked out for the kind where there is one: for a kind of something (Tenderstem, a kind of
        Broccoli) and for the generic item itself, every kind's purchases count, because buying florets one week
        and tenderstem the next is buying broccoli every week. Prices stay per product: for a kind, its own;
        for a generic item, one line per kind, since a mix of kinds' prices means little."""
        item = catalog_item(catalog_id)
        root = catalog_item(item["group_id"]) if item.get("group_id") else item
        rows = db.rows(
            "SELECT p.catalog_id, c.name AS kind_name, p.store, p.order_ref, p.bought_on, p.bought_at, "
            "p.name AS bought_as, p.qty, p.unit_price, p.source "
            "FROM purchases p JOIN catalog c ON c.id = p.catalog_id "
            "WHERE p.catalog_id = ? OR p.catalog_id IN (SELECT id FROM catalog WHERE group_id = ?) "
            "ORDER BY p.bought_at, p.id",
            (root["id"], root["id"]),
        )
        products = {r["catalog_id"] for r in rows}
        summary = item_stats(rows)
        own = [r for r in rows if r["catalog_id"] == catalog_id]
        if root["id"] != catalog_id:
            # A kind: timing for the whole kind, price and counts for this product.
            mine = item_stats(own) if own else None
            summary["price"] = mine["price"] if mine else None
            product = {"trips": mine["trips"] if mine else 0, "last_bought": mine["last_bought"] if mine else None}
        else:
            product = None
            if len(products) > 1:
                summary["price"] = None
        by_kind = []
        if len(products) > 1:
            for kind_id in products:
                kr = [r for r in rows if r["catalog_id"] == kind_id]
                ks = item_stats(kr)
                by_kind.append({"id": kind_id, "name": kr[0]["kind_name"], "trips": ks["trips"],
                                "last_bought": ks["last_bought"], "price": ks["price"]})
            by_kind.sort(key=lambda k: (-k["trips"], k["name"]))
        return {
            "item": {"id": item["id"], "name": item["name"]},
            # Whose timing this is: the generic item, when it has kinds or this is one of them.
            "kind": {"id": root["id"], "name": root["name"], "kinds": len(products)} if len(products) > 1 or root["id"] != catalog_id else None,
            "summary": summary,
            "product": product,
            "by_kind": by_kind,
            "weekly": weekly(rows, today(), shopped={r["w"] for r in db.rows(
                "SELECT DISTINCT date(bought_on, '-' || ((cast(strftime('%w', bought_on) AS integer) + 6) % 7) || ' days') AS w "
                "FROM purchases")}),
            # What you've spent on it: this product, or for a generic item every kind.
            "spend": round(sum(r["unit_price"] * r["qty"] for r in (own if root["id"] != catalog_id else rows)
                               if r["unit_price"] is not None), 2),
            "purchases": own if root["id"] != catalog_id else rows,
        }

    @app.get("/api/spending")
    def spend():
        """What you've spent, month by month, and how prices of what you buy have moved."""
        rows = db.rows(
            "SELECT p.catalog_id, c.name, p.bought_on, p.qty, p.unit_price, p.store || '|' || p.order_ref AS trip "
            "FROM purchases p LEFT JOIN catalog c ON c.id = p.catalog_id"
        )
        return spending(rows, today())

    @app.get("/userscript/" + USERSCRIPT_NAME, include_in_schema=False)
    def userscript(request: Request):
        """The Tampermonkey script, pointed back at this server."""
        template = next((d / USERSCRIPT_NAME for d in USERSCRIPT_DIRS if (d / USERSCRIPT_NAME).exists()), None)
        if not template:
            raise HTTPException(404, "The userscript isn't in this build")
        server = (os.environ.get("PUBLIC_URL") or str(request.base_url)).rstrip("/")
        host = urllib.parse.urlsplit(server).hostname or "localhost"
        script = template.read_text().replace("__SERVER__", server).replace("__HOST__", host)
        return Response(script, media_type="text/javascript; charset=utf-8", headers={"Cache-Control": "no-cache"})

    @app.post("/api/list", status_code=201)
    def add_to_list(body: NewListItem):
        """Add an item, or bump the quantity if it's already on the list and not yet ticked."""
        with db.tx() as conn:
            known = conn.execute(
                "SELECT id, barcode, category FROM catalog WHERE lower(name) = lower(?)", (body.name,)
            ).fetchone()
            category = aisle(body.category or (known["category"] if known else None))
            barcode = body.barcode or (known["barcode"] if known else "")
            existing = conn.execute(
                "SELECT id FROM list_items WHERE lower(name) = lower(?) AND done = 0", (body.name,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE list_items SET qty = min(qty + ?, 99) WHERE id = ?", (body.qty, existing["id"])
                )
                item_id = existing["id"]
            else:
                item_id = conn.execute(
                    "INSERT INTO list_items (name, category, qty, barcode) VALUES (?, ?, ?, ?)",
                    (body.name, category, body.qty, barcode),
                ).lastrowid
            # Anything typed in becomes a common item too, so it's one tap next time.
            if not known:
                conn.execute(
                    "INSERT INTO catalog (name, category, custom, barcode) VALUES (?, ?, 1, ?)",
                    (body.name, category, barcode),
                )
            elif body.barcode and not known["barcode"]:
                conn.execute("UPDATE catalog SET barcode = ? WHERE id = ?", (body.barcode, known["id"]))
        return list_item(item_id)

    @app.patch("/api/list/{item_id}")
    def change_list_item(item_id: int, body: ListItemChange):
        list_item(item_id)
        changes = body.model_dump(exclude_none=True)
        if changes:
            cols = ", ".join(f"{k} = ?" for k in changes)
            with db.tx() as conn:
                conn.execute(
                    f"UPDATE list_items SET {cols} WHERE id = ?",
                    (*[int(v) if isinstance(v, bool) else v for v in changes.values()], item_id),
                )
        return list_item(item_id)

    @app.delete("/api/list/{item_id}", status_code=204)
    def remove_from_list(item_id: int):
        with db.tx() as conn:
            conn.execute("DELETE FROM list_items WHERE id = ?", (item_id,))

    @app.post("/api/list/clear-done")
    def clear_done():
        with db.tx() as conn:
            removed = conn.execute("DELETE FROM list_items WHERE done = 1").rowcount
        return {"removed": removed}

    # The built React app. Any path that isn't an API call or a real file gets index.html.
    static = Path(static_dir or os.environ.get("STATIC_DIR", Path(__file__).parent.parent / "static"))
    if (static / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith(("api/", "userscript/")):
                raise HTTPException(404)
            file = (static / path).resolve()
            if path and file.is_file() and static.resolve() in file.parents:
                return FileResponse(file)
            return FileResponse(static / "index.html")

    return app


app = create_app() if os.environ.get("SHOPPING_NO_AUTOAPP") != "1" else None
