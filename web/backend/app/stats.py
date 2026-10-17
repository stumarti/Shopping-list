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
    usual_gap = median(gaps) if len(gaps) >= 2 else None
    out = {
        # How evenly spaced the buys are: 0 is like clockwork, 1 or more is all over the place.
        "unevenness": round(median(abs(g - usual_gap) for g in gaps) / usual_gap, 2) if usual_gap else None,
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


# Grouping for "You will want", "You might want" and "Extras".
REGULAR_MAX_GAP = 45  # an item bought less often than every ~6 weeks isn't part of the weekly shop
STEADY = 0.5  # unevenness up to this counts as a steady pace
DUE = 0.85  # this far through its usual gap, it's due
SOON = 0.6  # this far, it's coming up
EXTRAS_WITHIN = 365  # extras bought within the last year


def suggestion(stats: dict, today: datetime.date) -> tuple[str, str] | None:
    """("will" | "might" | "extras", a short reason), or None when it isn't worth suggesting now."""
    if not stats.get("last_bought") or stats["trips"] < 2:
        return None
    since = (today - datetime.date.fromisoformat(stats["last_bought"])).days
    gap = stats.get("every_days")
    ago = "today" if since == 0 else "yesterday" if since == 1 else f"{since} days ago"
    every = None if gap is None else "every week" if gap == 7 else f"every {gap} days"
    regular = gap is not None and 0 < gap <= REGULAR_MAX_GAP and stats["trips"] >= 3
    if regular:
        if since > 3 * gap + 14:
            return None  # used to buy it regularly, hasn't for a long while: probably stopped
        ratio = since / gap
        steady = (stats.get("unevenness") or 0) <= STEADY
        if steady and ratio >= DUE:
            return "will", f"About {every}, last {ago}"
        if (steady and ratio >= SOON) or (not steady and ratio >= DUE):
            return "might", f"Usually {every}, last {ago}"
        return None  # bought recently
    if since <= EXTRAS_WITHIN:
        return "extras", f"Now and then: {stats['trips']} times, last {ago}"
    return None


def group_suggestions(items: list[dict], today: datetime.date) -> dict[str, list[dict]]:
    """items: the history's per-item summaries. Returns {"will", "might", "extras"} lists, most useful first."""
    groups: dict[str, list[dict]] = {"will": [], "might": [], "extras": []}
    for item in items:
        found = suggestion(item, today)
        if found:
            group, reason = found
            groups[group].append({**item, "reason": reason, "qty": max(1, round(item.get("usual_qty") or 1))})

    def overdue(i: dict) -> float:
        since = (today - datetime.date.fromisoformat(i["last_bought"])).days
        return -(since / i["every_days"]) if i.get("every_days") else 0

    groups["will"].sort(key=lambda i: (overdue(i), -i["trips"], i["name"]))
    groups["might"].sort(key=lambda i: (overdue(i), -i["trips"], i["name"]))
    groups["extras"].sort(key=lambda i: (-i["trips"], -datetime.date.fromisoformat(i["last_bought"]).toordinal(), i["name"]))
    groups["extras"] = groups["extras"][:15]
    return groups
