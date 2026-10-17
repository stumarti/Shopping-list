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

from . import clubcard
from .catalog import CATEGORIES, guess_aisle
from .db import Database, category_order
from .stats import group_suggestions, item_stats
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


class NewListItem(NewCatalogItem):
    category: str | None = None  # left out: the common item's aisle, or Other
    qty: int = Field(default=1, ge=1, le=99)


class ListItemChange(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=99)
    done: bool | None = None
    note: str | None = Field(default=None, max_length=120)


def sort_items(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda i: (category_order(i["category"]), i["name"].lower()))


def _neg_date(iso: str | None) -> int:
    """Sort key putting the most recent date first."""
    return -datetime.date.fromisoformat(iso).toordinal() if iso else 0


def aisle(category: str | None) -> str:
    return category if category in CATEGORIES else "Other"


def create_app(
    db_path: str | None = None,
    static_dir: str | None = None,
    fetch: Fetch = http_fetch,
    today=datetime.date.today,
) -> FastAPI:
    db = Database(db_path or os.environ.get("DB_PATH", "shopping.db"))

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

    def catalog_item(item_id: int) -> dict:
        rows = db.rows("SELECT id, name, category, custom, barcode FROM catalog WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That common item has gone")
        rows[0]["custom"] = bool(rows[0]["custom"])
        return with_products(rows)[0]

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
        return CATEGORIES

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
        return found

    # Common items

    @app.get("/api/catalog")
    def get_catalog():
        items = db.rows("SELECT id, name, category, custom, barcode FROM catalog")
        for i in items:
            i["custom"] = bool(i["custom"])
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
        changes = body.model_dump(exclude_none=True)
        if "category" in changes:
            changes["category"] = aisle(changes["category"])
        if changes:
            with db.tx() as conn:
                if "name" in changes and conn.execute(
                    "SELECT 1 FROM catalog WHERE lower(name) = lower(?) AND id != ?", (changes["name"], item_id)
                ).fetchone():
                    raise HTTPException(409, f"{changes['name']} is already a common item")
                cols = ", ".join(f"{k} = ?" for k in changes)
                conn.execute(f"UPDATE catalog SET {cols} WHERE id = ?", (*changes.values(), item_id))
        return catalog_item(item_id)

    @app.delete("/api/catalog/{item_id}", status_code=204)
    def remove_from_catalog(item_id: int):
        with db.tx() as conn:
            conn.execute("DELETE FROM catalog WHERE id = ?", (item_id,))

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
                            "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, guess_aisle(title))
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
                        "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)", (name, guess_aisle(title))
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

    @app.get("/api/history")
    def history():
        """Imported orders, newest first, and the items bought most often."""
        orders = db.rows(
            "SELECT store, order_ref, bought_on, count(*) AS products, sum(qty) AS units, max(source) AS source "
            "FROM purchases GROUP BY store, order_ref ORDER BY bought_on DESC, order_ref"
        )
        rows = db.rows(
            "SELECT p.catalog_id, c.name, c.category, p.store, p.order_ref, p.bought_on, p.qty, p.unit_price "
            "FROM purchases p JOIN catalog c ON c.id = p.catalog_id ORDER BY p.bought_at, p.id"
        )
        by_item: dict[int, list[dict]] = {}
        for r in rows:
            by_item.setdefault(r["catalog_id"], []).append(r)
        usual = []
        for catalog_id, item_rows in by_item.items():
            stats = item_stats(item_rows)
            usual.append({
                "catalog_id": catalog_id,
                "name": item_rows[0]["name"],
                "category": item_rows[0]["category"],
                "orders": stats["trips"],
                **stats,
            })
        usual.sort(key=lambda u: (-u["orders"], _neg_date(u["last_bought"]), u["name"]))
        return {"orders": orders, "usual": usual[:40], "suggestions": group_suggestions(usual, today())}

    @app.get("/api/history/items/{catalog_id}")
    def item_history(catalog_id: int):
        """Every time this item was bought, oldest first, with what it cost, plus the summary."""
        item = catalog_item(catalog_id)
        rows = db.rows(
            "SELECT store, order_ref, bought_on, bought_at, name AS bought_as, qty, unit_price, source "
            "FROM purchases WHERE catalog_id = ? ORDER BY bought_at, id",
            (catalog_id,),
        )
        return {"item": {"id": item["id"], "name": item["name"]}, "summary": item_stats(rows), "purchases": rows}

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
