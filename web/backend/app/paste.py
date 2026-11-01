"""Working out what someone pasted (or dropped) into the paste box, so one box can update everything.

It can be:
- Tesco's Clubcard data export (the .json, or the .zip it comes in): every shopping trip.
- Past online orders, as the browser helper reads them: {"order_ref", "date", "items": [{"name", "qty", "url",
  "price"}]}, one or a list (or {"orders": [...]}).
- Claude in Chrome's reply after filling the basket, with its results block.
- Plain lines of text: things to add to the list, like "2 x milk".

Nothing here touches the database: `detect` says what it is and what it would do; the server applies it.
"""

import json
import re
import urllib.parse

from . import clubcard, results
from .lookup import STORES


class NotRecognised(ValueError):
    pass


def _json(text: str) -> object | None:
    try:
        return json.loads(text)
    except ValueError:
        return None


def store_of(url: str) -> str | None:
    """Which store a product link is from, by its address."""
    host = (urllib.parse.urlsplit(url.strip()).hostname or "").lower()
    for key, store in STORES.items():
        bare = store["host"].removeprefix("www.")
        if host == bare or host.endswith("." + bare):
            return key
    return None


def _orders(data: object) -> list[dict]:
    """Past orders in the data: dicts with a reference and items that have names and links."""
    if isinstance(data, dict) and isinstance(data.get("orders"), list):
        data = data["orders"]
    candidates = data if isinstance(data, list) else [data]
    found = []
    for o in candidates:
        if not isinstance(o, dict):
            return []
        ref = o.get("order_ref") or o.get("orderRef") or o.get("order_id") or o.get("orderId") or o.get("id")
        items = o.get("items")
        if not ref or not isinstance(items, list) or not items:
            return []
        lines = [i for i in items if isinstance(i, dict) and str(i.get("name") or "").strip() and str(i.get("url") or "").strip()]
        if not lines:
            return []
        found.append({"order_ref": str(ref)[:120], "date": str(o.get("date") or "")[:10], "items": lines})
    return found


_QTY = re.compile(r"^\s*(\d{1,2})\s*(?:x|×|\*)?\s+(.+?)\s*$|^\s*(.+?)\s*(?:x|×|\*)\s*(\d{1,2})\s*$", re.I)


def list_lines(text: str) -> list[dict]:
    """Things to add, one per line: "milk", "2 x milk", "milk x2", "- bread" (bullets and ticks dropped)."""
    out: dict[str, dict] = {}
    for raw in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•·]|\[[ xX]?\]|\d+[.)])\s+", "", raw).strip()
        if not line or len(line) > 80:
            continue
        qty, name = 1, line
        m = _QTY.match(line)
        if m:
            qty, name = (int(m.group(1)), m.group(2)) if m.group(1) else (int(m.group(4)), m.group(3))
        name = " ".join(name.split()).strip(" ,;")
        if not name or qty < 1:
            continue
        key = name.lower()
        if key in out:
            out[key]["qty"] = min(99, out[key]["qty"] + qty)
        else:
            out[key] = {"name": name[:80], "qty": min(99, qty)}
    return list(out.values())


def _looks_like_basket(text: str) -> bool:
    return bool(re.search(r'"status"\s*:', results._tidy_quotes(text)))


def detect(raw: bytes) -> dict:
    """{"kind": "clubcard" | "orders" | "basket" | "list", ...what it holds}. Raises NotRecognised."""
    if not raw.strip():
        raise NotRecognised("There's nothing there yet. Paste something, or drop a file.")
    if raw[:2] == b"PK":
        try:
            trips, not_groceries = clubcard.parse(clubcard.load(raw))
        except ValueError as e:
            raise NotRecognised(str(e))
        except Exception:
            raise NotRecognised("Couldn't read that zip. Is it the file from Tesco's data download?")
        return _clubcard(trips, not_groceries)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise NotRecognised("That isn't text or a file Press knows. Paste JSON or a list, or drop Tesco's data file.")

    data = _json(text.strip())
    if data is not None:
        if clubcard.find_purchases(data):
            trips, not_groceries = clubcard.parse(data)
            if trips:
                return _clubcard(trips, not_groceries)
        orders = _orders(data)
        if orders:
            return _past_orders(orders)
    if _looks_like_basket(text):
        try:
            parsed = results.parse(text)
        except ValueError as e:
            raise NotRecognised(str(e))
        stores = {store_of(i["url"]) for i in parsed["items"] if i["url"]} - {None}
        counts = {s: sum(1 for i in parsed["items"] if i["status"] == s) for s in ("added", "swapped", "missing")}
        return {"kind": "basket", "store": stores.pop() if len(stores) == 1 else None, "items": len(parsed["items"]),
                "counts": counts, "total": parsed["total"]}
    if data is not None or text.lstrip().startswith("{"):
        raise NotRecognised(
            "That's JSON, but not one Press knows. It takes Tesco's Clubcard data, past orders from the browser helper, "
            "or Claude's basket results."
        )
    lines = list_lines(text)
    if not lines:
        raise NotRecognised("Couldn't find anything in that. Paste one thing per line, like \"2 x milk\".")
    return {"kind": "list", "items": lines}


def _clubcard(trips: list, not_groceries: int) -> dict:
    if not trips:
        raise NotRecognised("No shopping trips found in that. Is it the Tesco data download?")
    dates = sorted(t.bought_on for t in trips)
    return {"kind": "clubcard", "trips": len(trips), "from": dates[0], "to": dates[-1], "not_groceries": not_groceries,
            "products": sum(len(t.lines) for t in trips)}


def _past_orders(orders: list[dict]) -> dict:
    out = []
    for o in orders:
        stores = {store_of(str(i["url"])) for i in o["items"]} - {None}
        if len(stores) != 1:
            raise NotRecognised(f"Order {o['order_ref']} has links from no store Press knows (or from more than one).")
        out.append({**o, "store": stores.pop()})
    dates = sorted(o["date"] for o in out if o["date"])
    return {"kind": "orders", "orders": out, "products": sum(len(o["items"]) for o in out),
            "from": dates[0] if dates else "", "to": dates[-1] if dates else ""}
