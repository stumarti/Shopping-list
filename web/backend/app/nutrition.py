"""Calories and macros per pack from Open Food Facts, by barcode.

Open Food Facts gives nutrition per 100 g (or 100 ml for drinks) and the pack size; a pack's figures are the
per-100 values scaled to the pack. Only empty figures are filled: anything you've typed stays.

It allows about 100 product reads a minute, so filling every item runs in the background, one read every `gap`
seconds, and Settings shows its progress.
"""

import datetime
import re
import threading
import urllib.parse

from .lookup import Fetch

FIGURES = ("kcal", "protein", "carbs", "fat")
FIELDS = "product_name,brands,quantity,product_quantity,product_quantity_unit,nutriments"
PER_100 = {"protein": "proteins_100g", "carbs": "carbohydrates_100g", "fat": "fat_100g"}
TO_GRAMS = {"g": 1, "gr": 1, "gram": 1, "grams": 1, "kg": 1000, "ml": 1, "cl": 10, "l": 1000, "litre": 1000, "litres": 1000, "ltr": 1000}


def pack_size(product: dict) -> float | None:
    """Grams (or millilitres) in the pack: Open Food Facts' own figure, else read from the label ("6 x 330 ml")."""
    try:
        size = float(product.get("product_quantity") or 0)
    except (TypeError, ValueError):
        size = 0
    if size > 0:
        unit = (product.get("product_quantity_unit") or "g").lower()
        return size * TO_GRAMS.get(unit, 1)
    text = (product.get("quantity") or "").lower().replace(",", ".")
    m = re.search(r"(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|grams?|gr|g|ml|cl|litres?|ltr|l)\b", text)
    if not m:
        return None
    count = int(m.group(1)) if m.group(1) else 1
    return count * float(m.group(2)) * TO_GRAMS[m.group(3)]


def pack_nutrition(product: dict) -> dict | None:
    """{kcal, protein, carbs, fat (those known), size, basis} for the whole pack, or None when Open Food Facts
    has no per-100 figures or no pack size for it."""
    n = product.get("nutriments") or {}
    size = pack_size(product)
    if not size:
        return None

    def number(key: str) -> float | None:
        try:
            v = n.get(key)
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    per100 = {"kcal": number("energy-kcal_100g")}
    if per100["kcal"] is None and number("energy_100g") is not None:
        per100["kcal"] = number("energy_100g") / 4.184  # kJ
    for figure, key in PER_100.items():
        per100[figure] = number(key)
    if all(v is None for v in per100.values()):
        return None
    out = {}
    for figure, v in per100.items():
        if v is not None:
            total = v * size / 100
            out[figure] = round(total) if figure == "kcal" else round(total, 1)
    unit = "ml" if (product.get("product_quantity_unit") or "").lower() in ("ml", "cl", "l") or re.search(r"\d\s*(ml|cl|l)\b", (product.get("quantity") or "").lower()) else "g"
    out["size"] = size
    out["basis"] = f"per 100 {unit} × {size:g} {unit}"
    return out


def look_up(code: str, fetch: Fetch) -> dict | None:
    """The product's nutrition per pack from Open Food Facts, or None if it isn't there or has none.
    Raises OSError when Open Food Facts can't be reached."""
    try:
        data = fetch(f"https://world.openfoodfacts.org/api/v2/product/{urllib.parse.quote(code)}.json?fields={FIELDS}") or {}
    except Exception as e:
        raise OSError(f"Couldn't reach Open Food Facts: {e}")
    product = data.get("product") if data.get("status") == 1 else None
    return pack_nutrition(product) if product else None


def fill(conn, item_id: int, found: dict, overwrite: bool = False) -> list[str]:
    """Write the figures into the item, only where it has none (unless overwrite). Returns what was filled."""
    row = conn.execute("SELECT kcal, protein, carbs, fat FROM catalog WHERE id = ?", (item_id,)).fetchone()
    filled = [f for f in FIGURES if f in found and (overwrite or row[f] is None)]
    now = datetime.datetime.now().isoformat(timespec="seconds")
    sets = ", ".join(f"{f} = ?" for f in filled)
    conn.execute(
        f"UPDATE catalog SET {sets + ', ' if sets else ''}nutrition_checked_at = ? WHERE id = ?",
        (*[found[f] for f in filled], now, item_id),
    )
    return filled


class NutritionFiller:
    """Fills calories and macros for every item with a barcode and a figure missing, in the background."""

    def __init__(self, db, fetch: Fetch, gap: float):
        self.db, self.fetch, self.gap = db, fetch, gap
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None
        self.state = {"running": False, "total": 0, "done": 0, "filled": [], "current": None, "error": None}

    def _todo(self, retry: bool) -> list[dict]:
        return self.db.rows(
            "SELECT id, name, barcode FROM catalog WHERE barcode != '' AND kind != 'or' "
            "AND (kcal IS NULL OR protein IS NULL OR carbs IS NULL OR fat IS NULL) "
            "AND (? OR nutrition_checked_at = '') ORDER BY id",
            (int(retry),),
        )

    def status(self) -> dict:
        with self.lock:
            return {**self.state, "filled": list(self.state["filled"]), "waiting": len(self._todo(retry=False))}

    def start(self, retry: bool) -> dict:
        with self.lock:
            if not self.state["running"]:
                todo = self._todo(retry)
                self.stopping.clear()
                self.state = {"running": bool(todo), "total": len(todo), "done": 0, "filled": [], "current": None, "error": None}
                if todo:
                    self.thread = threading.Thread(target=self._run, args=(todo,), daemon=True)
                    self.thread.start()
        return self.status()

    def stop(self) -> dict:
        self.stopping.set()
        return self.status()

    def wait(self, timeout: float = 30):
        if self.thread:
            self.thread.join(timeout)

    def _run(self, todo: list[dict]):
        try:
            for n, item in enumerate(todo):
                if self.stopping.is_set():
                    break
                with self.lock:
                    self.state["current"] = item["name"]
                try:
                    found = look_up(item["barcode"], self.fetch)
                except OSError as e:
                    with self.lock:
                        self.state["error"] = f"{e}. Try again later; it carries on where it stopped."
                    break
                with self.db.tx() as conn:
                    filled = fill(conn, item["id"], found or {})
                with self.lock:
                    self.state["done"] = n + 1
                    if filled:
                        self.state["filled"].append({"catalog_id": item["id"], "name": item["name"], "filled": filled,
                                                     **{f: found[f] for f in filled}, "basis": found["basis"]})
                if n + 1 < len(todo) and self.stopping.wait(self.gap):
                    break
        finally:
            with self.lock:
                self.state["running"] = False
                self.state["current"] = None
