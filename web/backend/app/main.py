import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .catalog import CATEGORIES
from .db import Database, category_order


class NewCatalogItem(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    category: str = "Other"

    @field_validator("name")
    @classmethod
    def tidy(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Name can't be empty")
        return v[0].upper() + v[1:]


class NewListItem(NewCatalogItem):
    qty: int = Field(default=1, ge=1, le=99)


class ListItemChange(BaseModel):
    qty: int | None = Field(default=None, ge=1, le=99)
    done: bool | None = None
    note: str | None = Field(default=None, max_length=120)


def sort_items(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda i: (category_order(i["category"]), i["name"].lower()))


def create_app(db_path: str | None = None, static_dir: str | None = None) -> FastAPI:
    db = Database(db_path or os.environ.get("DB_PATH", "shopping.db"))
    app = FastAPI(title="Shopping list")

    def list_item(item_id: int) -> dict:
        rows = db.rows("SELECT * FROM list_items WHERE id = ?", (item_id,))
        if not rows:
            raise HTTPException(404, "That item isn't on the list any more")
        row = rows[0]
        row["done"] = bool(row["done"])
        return row

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/categories")
    def categories():
        return CATEGORIES

    @app.get("/api/catalog")
    def get_catalog():
        items = db.rows("SELECT id, name, category, custom FROM catalog")
        for i in items:
            i["custom"] = bool(i["custom"])
        return sort_items(items)

    @app.post("/api/catalog", status_code=201)
    def add_to_catalog(body: NewCatalogItem):
        category = body.category if body.category in CATEGORIES else "Other"
        with db.tx() as conn:
            existing = conn.execute(
                "SELECT id FROM catalog WHERE lower(name) = lower(?)", (body.name,)
            ).fetchone()
            if existing:
                raise HTTPException(409, f"{body.name} is already in the list of common items")
            cur = conn.execute(
                "INSERT INTO catalog (name, category, custom) VALUES (?, ?, 1)",
                (body.name, category),
            )
        return {"id": cur.lastrowid, "name": body.name, "category": category, "custom": True}

    @app.delete("/api/catalog/{item_id}", status_code=204)
    def remove_from_catalog(item_id: int):
        with db.tx() as conn:
            conn.execute("DELETE FROM catalog WHERE id = ?", (item_id,))

    @app.get("/api/list")
    def get_list():
        items = db.rows("SELECT * FROM list_items")
        for i in items:
            i["done"] = bool(i["done"])
        return sort_items(items)

    @app.post("/api/list", status_code=201)
    def add_to_list(body: NewListItem):
        """Add an item, or bump the quantity if it's already on the list and not yet ticked."""
        category = body.category if body.category in CATEGORIES else "Other"
        with db.tx() as conn:
            existing = conn.execute(
                "SELECT id FROM list_items WHERE lower(name) = lower(?) AND done = 0", (body.name,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE list_items SET qty = min(qty + ?, 99) WHERE id = ?",
                    (body.qty, existing["id"]),
                )
                item_id = existing["id"]
            else:
                item_id = conn.execute(
                    "INSERT INTO list_items (name, category, qty) VALUES (?, ?, ?)",
                    (body.name, category, body.qty),
                ).lastrowid
                # Anything typed in becomes a common item too, so it's one tap next time.
                conn.execute(
                    "INSERT OR IGNORE INTO catalog (name, category, custom) VALUES (?, ?, 1)",
                    (body.name, category),
                )
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
