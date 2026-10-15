import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .catalog import CATEGORIES
from .db import Database, category_order
from .lookup import Fetch, http_fetch, is_barcode, link_templates, lookup_barcode


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


class NewListItem(NewCatalogItem):
    qty: int = Field(default=1, ge=1, le=99)


class ListItemChange(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=99)
    done: bool | None = None
    note: str | None = Field(default=None, max_length=120)


def sort_items(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda i: (category_order(i["category"]), i["name"].lower()))


def aisle(category: str | None) -> str:
    return category if category in CATEGORIES else "Other"


def create_app(db_path: str | None = None, static_dir: str | None = None, fetch: Fetch = http_fetch) -> FastAPI:
    db = Database(db_path or os.environ.get("DB_PATH", "shopping.db"))
    app = FastAPI(title="Shopping list")

    def list_item(item_id: int) -> dict:
        rows = db.rows("SELECT * FROM list_items WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That item isn't on the list any more")
        row = rows[0]
        row["done"] = bool(row["done"])
        return row

    def catalog_item(item_id: int) -> dict:
        rows = db.rows("SELECT id, name, category, custom, barcode FROM catalog WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That common item has gone")
        rows[0]["custom"] = bool(rows[0]["custom"])
        return rows[0]

    @app.get("/api/health")
    def health():
        return {"ok": True}

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
        return sort_items(items)

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

    # The list

    @app.get("/api/list")
    def get_list():
        items = db.rows("SELECT * FROM list_items")
        for i in items:
            i["done"] = bool(i["done"])
        return sort_items(items)

    @app.post("/api/list", status_code=201)
    def add_to_list(body: NewListItem):
        """Add an item, or bump the quantity if it's already on the list and not yet ticked."""
        category = aisle(body.category)
        with db.tx() as conn:
            known = conn.execute(
                "SELECT id, barcode FROM catalog WHERE lower(name) = lower(?)", (body.name,)
            ).fetchone()
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
            if path.startswith("api/"):
                raise HTTPException(404)
            file = (static / path).resolve()
            if path and file.is_file() and static.resolve() in file.parents:
                return FileResponse(file)
            return FileResponse(static / "index.html")

    return app


app = create_app() if os.environ.get("SHOPPING_NO_AUTOAPP") != "1" else None
