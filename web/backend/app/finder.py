"""Finding barcodes for common items by searching Open Food Facts (and its sister databases) by name.

A barcode is only assigned when the product found clearly is the item: nearly every word of the item's name
appears in the product's brand, name and size, and the product doesn't add much else. The generic starter items
("Milk", "Sliced pan") and one-word names are skipped, since any milk's barcode would be a guess.

Open Food Facts allows about 10 searches a minute, so this runs in the background, one search every
`gap` seconds, and the page shows its progress.
"""

import datetime
import re
import threading
import urllib.parse

from .lookup import Fetch

SEARCH_HOSTS = [
    ("world.openfoodfacts.org", "openfoodfacts"),
    ("world.openbeautyfacts.org", "openbeautyfacts"),
    ("world.openproductsfacts.org", "openproductsfacts"),
]
FIELDS = "code,product_name,product_name_en,brands,quantity,countries_tags"

# Words that don't tell products apart.
STOP = {"the", "and", "with", "of", "in", "a", "x", "pack", "for", "&"}
UNITS = {
    "litre": "l", "litres": "l", "liter": "l", "ltr": "l", "lt": "l",
    "millilitre": "ml", "grams": "g", "gram": "g", "gr": "g", "kilo": "kg", "kilos": "kg",
}
MIN_COVER = 0.75  # share of the item's words found in the product
MIN_PRECISION = 0.5  # share of the product's words found in the item


def words(text: str) -> set[str]:
    t = text.lower().replace("'", "")
    t = re.sub(r"(\d+(?:[.,]\d+)?)\s*(litres?|liters?|ltr|lt|millilitre|ml|grams?|gr|kg|kilos?|g|l)\b",
               lambda m: m.group(1).replace(",", ".") + UNITS.get(m.group(2), m.group(2)), t)
    return {w for w in re.findall(r"[a-z0-9.]+", t) if w not in STOP and w != "."}


def score(item_name: str, product: dict) -> tuple[float, float]:
    """(how much of the item the product covers, how much of the product the item covers)."""
    want = words(item_name)
    name = product.get("product_name_en") or product.get("product_name") or ""
    have = words(" ".join([product.get("brands") or "", name, product.get("quantity") or ""]))
    if not want or not have:
        return 0.0, 0.0
    common = want & have
    return len(common) / len(want), len(common) / len(have)


def best_match(item_name: str, products: list[dict]) -> tuple[dict, float] | None:
    best = None
    for p in products:
        code = str(p.get("code") or "")
        if not code.isdigit() or not 8 <= len(code) <= 14:
            continue
        cover, precision = score(item_name, p)
        if cover < MIN_COVER or precision < MIN_PRECISION:
            continue
        rank = cover + precision + (0.1 if "en:ireland" in (p.get("countries_tags") or []) else 0)
        if best is None or rank > best[1]:
            best = (p, rank)
    return best


def worth_searching(name: str) -> bool:
    return len(words(name)) >= 2


class BarcodeFinder:
    def __init__(self, db, fetch: Fetch, gap: float):
        self.db, self.fetch, self.gap = db, fetch, gap
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None
        self.state = {"running": False, "total": 0, "done": 0, "found": [], "current": None, "error": None}

    def status(self) -> dict:
        with self.lock:
            todo = len(self._todo(retry=False))
            return {**self.state, "found": list(self.state["found"]), "waiting": todo}

    def _todo(self, retry: bool) -> list[dict]:
        rows = self.db.rows(
            "SELECT id, name FROM catalog WHERE barcode = '' AND custom = 1 AND kind != 'or' AND (? OR barcode_checked_at = '') ORDER BY id", (int(retry),)
        )
        return [r for r in rows if worth_searching(r["name"])]

    def start(self, retry: bool) -> dict:
        with self.lock:
            if not self.state["running"]:
                todo = self._todo(retry)
                self.stopping.clear()
                self.state = {"running": bool(todo), "total": len(todo), "done": 0, "found": [], "current": None, "error": None}
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

    def _search(self, name: str) -> tuple[dict, str] | None:
        q = urllib.parse.quote(name)
        failures = 0
        for host, source in SEARCH_HOSTS:
            url = (f"https://{host}/cgi/search.pl?search_terms={q}&search_simple=1&action=process&json=1"
                   f"&page_size=10&fields={FIELDS}")
            try:
                data = self.fetch(url) or {}
            except Exception:
                failures += 1
                continue
            match = best_match(name, data.get("products") or [])
            if match:
                return match[0], source
            # Food first; only look in the others when the food database had nothing close.
            if data.get("products"):
                break
        if failures == len(SEARCH_HOSTS):
            raise OSError("Couldn't reach Open Food Facts")
        return None

    def _run(self, todo: list[dict]):
        try:
            for n, item in enumerate(todo):
                if self.stopping.is_set():
                    break
                with self.lock:
                    self.state["current"] = item["name"]
                try:
                    found = self._search(item["name"])
                except OSError as e:
                    with self.lock:
                        self.state["error"] = f"{e}. Try again later; it carries on where it stopped."
                    break
                now = datetime.datetime.now().isoformat(timespec="seconds")
                with self.db.tx() as conn:
                    if found:
                        product, source = found
                        # Only fill an empty barcode: one set meanwhile (by you) wins.
                        changed = conn.execute(
                            "UPDATE catalog SET barcode = ?, barcode_source = ?, barcode_checked_at = ? "
                            "WHERE id = ? AND barcode = ''",
                            (str(product["code"]), source, now, item["id"]),
                        ).rowcount
                    else:
                        changed = 0
                        conn.execute("UPDATE catalog SET barcode_checked_at = ? WHERE id = ?", (now, item["id"]))
                with self.lock:
                    self.state["done"] = n + 1
                    if changed:
                        name = product.get("product_name_en") or product.get("product_name") or ""
                        self.state["found"].append({
                            "catalog_id": item["id"], "name": item["name"], "barcode": str(product["code"]),
                            "product": " ".join(x for x in [product.get("brands") or "", name, product.get("quantity") or ""] if x).strip(),
                            "source": source,
                        })
                if n + 1 < len(todo) and self.stopping.wait(self.gap):
                    break
        finally:
            with self.lock:
                self.state["running"] = False
                self.state["current"] = None
