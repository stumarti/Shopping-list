"""Reading back what Claude in Chrome says it put in the basket.

The prompt asks it to end with a JSON block: {"results": [{"item", "status", "product", "url", "qty", "note"}],
"total"}. People paste the whole reply, so the block is found inside whatever text surrounds it.
"""

import json
import re

STATUSES = {
    "added": "added", "add": "added", "ok": "added", "in basket": "added", "in_basket": "added", "done": "added",
    "swapped": "swapped", "swap": "swapped", "substituted": "swapped", "replaced": "swapped", "cheaper": "swapped",
    "missing": "missing", "not found": "missing", "not_found": "missing", "unavailable": "missing",
    "out of stock": "missing", "out_of_stock": "missing", "skipped": "missing", "failed": "missing",
}


def _candidates(text: str):
    """JSON-looking pieces of the text, most likely first: fenced blocks, then the widest {...} span."""
    for m in re.finditer(r"```(?:json)?\s*(.*?)```", text, re.S | re.I):
        yield m.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        yield text[start:end + 1]
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        yield text[start:end + 1]


def _tidy_quotes(s: str) -> str:
    return s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")


def parse(text: str) -> dict:
    """{"items": [{item, status, product, url, qty, note}], "total": str}. Raises ValueError with a friendly
    reason when there's no results block in the text."""
    data = None
    for piece in _candidates(text):
        for attempt in (piece, _tidy_quotes(piece)):
            try:
                data = json.loads(attempt)
                break
            except ValueError:
                continue
        if isinstance(data, (dict, list)):
            break
        data = None
    if data is None:
        raise ValueError("Couldn't find Claude's results in that. Paste the whole reply, including the block at the end.")
    rows = data.get("results", data.get("items")) if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise ValueError("The results block is empty. Ask Claude to fill it in for every item on the list.")

    items = []
    for row in rows:
        if not isinstance(row, dict) or not str(row.get("item", "")).strip():
            continue
        status = STATUSES.get(str(row.get("status", "")).strip().lower(), "missing")
        try:
            qty = float(row["qty"]) if row.get("qty") not in (None, "") else None
        except (TypeError, ValueError):
            qty = None
        items.append({
            "item": " ".join(str(row["item"]).split())[:120],
            "status": status,
            "product": " ".join(str(row.get("product") or "").split())[:200],
            "url": str(row.get("url") or "").strip()[:500],
            "qty": qty,
            "note": " ".join(str(row.get("note") or "").split())[:300],
        })
    if not items:
        raise ValueError("The results block has no items in it.")
    total = data.get("total") if isinstance(data, dict) else None
    return {"items": items, "total": str(total).strip()[:40] if total not in (None, "") else ""}


def key(name: str) -> str:
    """How item names are matched: lower case, spaces squashed, quantities like "2 x" or "× 2" dropped."""
    name = name.lower().replace("×", "x")
    name = re.sub(r"^\s*\d+\s*x\s+", "", name)
    name = re.sub(r"\s+x\s*\d+\s*$", "", name)
    name = re.sub(r"\s*\[exact[^\]]*\]", "", name)
    return " ".join(name.split())
