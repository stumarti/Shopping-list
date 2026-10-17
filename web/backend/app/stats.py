"""How often each item is bought, and what it has cost, from the purchase history."""

import datetime
from statistics import median


def item_stats(rows: list[dict]) -> dict:
    """rows: one item's purchases, oldest first, each {store, order_ref, bought_on, qty, unit_price}.

    Returns trips (shopping trips it was on), first/last bought, every_days (the usual gap between
    buying it, once there are three or more trips), usual_qty, and its price now, before, lowest and highest."""
    days = sorted({r["bought_on"] for r in rows})
    trips = len({(r["store"], r["order_ref"]) for r in rows})
    gaps = [
        (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days for a, b in zip(days, days[1:])
    ]
    priced = [r for r in rows if r.get("unit_price") is not None]
    out = {
        "trips": trips,
        "first_bought": days[0] if days else None,
        "last_bought": days[-1] if days else None,
        "every_days": round(median(gaps)) if len(gaps) >= 2 else None,
        "usual_qty": round(sum(r["qty"] for r in rows) / trips, 1) if trips else None,
        "price": None,
    }
    if priced:
        values = [r["unit_price"] for r in priced]
        out["price"] = {
            "now": priced[-1]["unit_price"],
            "now_on": priced[-1]["bought_on"],
            "first": priced[0]["unit_price"],
            "first_on": priced[0]["bought_on"],
            "low": min(values),
            "high": max(values),
        }
    return out
