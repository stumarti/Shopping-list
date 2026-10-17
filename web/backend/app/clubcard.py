"""Reading Tesco's Clubcard data export ("Request your Tesco data").

The file is JSON, or a zip of JSON files. The part we use looks like:

    {"purchases": [{"timestamp": "2026-10-12 15:20:43.586", "type": "IN_STORE", "basketValueGross": 65.5,
                    "payment": [...], "items": [{"name": "...", "quantity": 2, "weight": 0.0, "price": 10.0}, ...]}]}

Nothing in it is thrown away: the server keeps the uploaded file, and every trip and line exactly as
exported. The parts read here feed the history, common items and price figures.
"""

import datetime
import io
import json
import re
import zipfile
from dataclasses import dataclass, field

# Lines that aren't groceries: Tesco's clothing brand, bags, gift cards, Clubcard vouchers and the like.
NOT_GROCERIES = re.compile(
    r"^(f\s*&\s*f\b|f&f\b)|\b(bag for life|carrier bag|plastic bag|paper bag|bag levy|gift card|top[- ]?up|"
    r"clubcard|voucher|coupon|lottery|phone credit)\b",
    re.I,
)


@dataclass
class Trip:
    ref: str
    bought_on: str
    bought_at: str  # 2026-10-12T15:20:43
    kind: str  # "in store" or "online"
    raw: dict = field(default_factory=dict)  # the trip exactly as exported
    lines: dict[str, dict] = field(default_factory=dict)  # groceries: name → {qty, unit_price}


def load(raw: bytes) -> object:
    """The export as JSON, whether it came as a .json file or a zip of them."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            parts = [json.loads(z.read(n).decode("utf-8-sig")) for n in z.namelist() if n.lower().endswith(".json")]
        if not parts:
            raise ValueError("That zip has no JSON files in it. Upload the file from Tesco's data download.")
        return parts
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("That doesn't look like Tesco's data file. It should be a .json file (or a zip of them).")


def find_purchases(data: object) -> list[dict]:
    """Every shopping trip in the file, wherever it sits: lists under a "purchases" key, or any list of
    objects that each have a timestamp and items."""
    found: list[dict] = []

    def walk(node: object):
        if isinstance(node, dict):
            for key, value in node.items():
                if key.lower() == "purchases" and isinstance(value, list):
                    found.extend(v for v in value if isinstance(v, dict))
                else:
                    walk(value)
        elif isinstance(node, list):
            if node and all(isinstance(v, dict) and "items" in v and "timestamp" in v for v in node):
                found.extend(node)
            else:
                for value in node:
                    walk(value)

    walk(data)
    return found


def _when(timestamp: object) -> tuple[str, str] | None:
    """(date, date and time to the second), or None if it isn't a timestamp."""
    text = str(timestamp).strip().replace("T", " ")
    try:
        day = datetime.date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return None
    try:
        at = datetime.datetime.fromisoformat(text[:19]).isoformat(timespec="seconds")
    except ValueError:
        at = day
    return day, at


def _price(line: dict) -> float | None:
    price = line.get("price")
    return float(price) if isinstance(price, (int, float)) and not isinstance(price, bool) else None


def prices_are_line_totals(purchase: dict) -> bool:
    """Whether "price" is what the whole line cost rather than one item.

    Decided per trip by which reading adds up closer to the basket total. Trips where everything is a single
    item read the same either way."""
    total = purchase.get("basketValueGross")
    if not isinstance(total, (int, float)):
        return False
    items = [i for i in purchase.get("items") or [] if isinstance(i, dict) and _price(i) is not None]
    per_item = sum(_price(i) * _qty(i) for i in items)
    per_line = sum(_price(i) for i in items)
    return abs(per_line - total) < abs(per_item - total)


def _qty(line: dict) -> int:
    try:
        q = float(line.get("quantity") or 0)
    except (TypeError, ValueError):
        q = 0
    # Loose fruit and veg come by weight with no count; that's one of them.
    return max(1, min(99, round(q))) if q >= 0.5 else 1


def parse(data: object) -> tuple[list[Trip], int]:
    """(trips, number of lines skipped as not groceries)."""
    trips: dict[str, Trip] = {}
    skipped = 0
    for p in find_purchases(data):
        when = _when(p.get("timestamp"))
        if not when:
            continue
        kind = "online" if "online" in str(p.get("type", "")).lower() else "in store"
        ref = f"clubcard:{str(p.get('timestamp')).strip()}"
        trip = trips.setdefault(ref, Trip(ref, when[0], when[1], kind, raw=p))
        line_totals = prices_are_line_totals(p)
        for line in p.get("items") or []:
            if not isinstance(line, dict):
                continue
            name = " ".join(str(line.get("name") or "").split())
            if not name:
                continue
            if NOT_GROCERIES.search(name):
                skipped += 1
                continue
            qty = _qty(line)
            entry = trip.lines.setdefault(name, {"qty": 0, "unit_price": None})
            entry["qty"] = min(99, entry["qty"] + qty)
            price = _price(line)
            if price is not None:
                entry["unit_price"] = round(price / qty if line_totals else price, 2)
    return list(trips.values()), skipped


def is_grocery(name: str) -> bool:
    return not NOT_GROCERIES.search(name)


def number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
