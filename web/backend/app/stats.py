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
        # When it's likely to be bought next: the last time plus the usual gap.
        "next_expected": (
            (datetime.date.fromisoformat(days[-1]) + datetime.timedelta(days=round(usual_gap))).isoformat()
            if usual_gap and days else None
        ),
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


def weekly(rows: list[dict], today: datetime.date, weeks: int = 52) -> list[dict]:
    """How many were bought each week (Monday to Sunday), for the last `weeks` weeks up to this one,
    starting no earlier than the week of the first purchase."""
    this_week = today - datetime.timedelta(days=today.weekday())
    start = this_week - datetime.timedelta(weeks=weeks - 1)
    if rows:
        first = datetime.date.fromisoformat(min(r["bought_on"] for r in rows))
        start = max(start, first - datetime.timedelta(days=first.weekday()))
    counts: dict[datetime.date, dict] = {}
    for r in rows:
        d = datetime.date.fromisoformat(r["bought_on"])
        week = d - datetime.timedelta(days=d.weekday())
        c = counts.setdefault(week, {"qty": 0, "trips": set()})
        c["qty"] += r["qty"]
        c["trips"].add((r["store"], r["order_ref"]))
    out = []
    week = start
    while week <= this_week:
        c = counts.get(week)
        out.append({"week": week.isoformat(), "qty": c["qty"] if c else 0, "trips": len(c["trips"]) if c else 0})
        week += datetime.timedelta(weeks=1)
    return out


# The next shop: when it's likely to be, and what it needs.

def shop_plan_date(trip_days: list[str], today: datetime.date) -> dict | None:
    """When the next shop is likely: the last shop plus the usual gap between shops, moved to the day of the
    week you usually shop on, and never in the past. trip_days: the dates you shopped (any order)."""
    days = sorted({datetime.date.fromisoformat(d) for d in trip_days})
    if not days:
        return None
    recent = [d for d in days if d >= days[-1] - datetime.timedelta(days=120)] or days
    gaps = [(b - a).days for a, b in zip(recent, recent[1:]) if (b - a).days > 0]
    gap = round(median(gaps)) if gaps else 7
    last_dozen = recent[-12:]
    weekday = max(range(7), key=lambda w: (sum(d.weekday() == w for d in last_dozen), -w))
    usual_day = sum(d.weekday() == weekday for d in last_dozen) >= max(2, len(last_dozen) // 3)
    target = max(days[-1] + datetime.timedelta(days=gap), today)
    if usual_day:
        # The usual shopping day nearest the target, but not before today.
        options = [target + datetime.timedelta(days=k) for k in range(-3, 4)]
        options = [d for d in options if d >= today and d.weekday() == weekday]
        if options:
            target = min(options, key=lambda d: abs((d - target).days))
    names = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"]
    every = "every week" if gap == 7 else f"every {gap} days"
    reason = f"You usually shop on {names[weekday]}, about {every}" if usual_day else f"You usually shop about {every}"
    return {"date": target.isoformat(), "every_days": gap, "last_shop": days[-1].isoformat(), "reason": reason}


def short_date(d: datetime.date, weekday: bool = False) -> str:
    text = f"{d.day} {d.strftime('%b')}"
    return f"{d.strftime('%a')} {text}" if weekday else text


def weeks_text(days: int) -> str:
    if days % 7 == 0 or abs(days - round(days / 7) * 7) <= 1:
        w = round(days / 7)
        return "Weekly" if w == 1 else f"Every {w} weeks"
    return f"Every {days} days"


def for_next_shop(item: dict, shop: datetime.date, shop_every: int, today: datetime.date) -> dict | None:
    """Whether an item belongs on the next shop, and its badge: {"badge": "weekly" | "scheduled" | "unsure",
    "label", "detail"}. It's in when it's expected before about halfway to the shop after this one, so it
    doesn't run out in between."""
    if not item.get("last_bought") or item["trips"] < 3 or not item.get("next_expected"):
        return None
    gap = item.get("every_days")
    since = (today - datetime.date.fromisoformat(item["last_bought"])).days
    if gap and since > 3 * gap + 14:
        return None  # used to, but seems to have stopped
    expected = datetime.date.fromisoformat(item["next_expected"])
    if expected > shop + datetime.timedelta(days=shop_every / 2):
        return None
    when = "overdue" if expected < today else f"due {short_date(expected, weekday=True)}"
    steady = (item.get("unevenness") or 0) <= STEADY
    if gap and gap <= REGULAR_MAX_GAP and steady:
        label = weeks_text(gap)
        last = short_date(datetime.date.fromisoformat(item["last_bought"]))
        return {"badge": "weekly" if label == "Weekly" else "scheduled", "label": label, "detail": f"Last bought {last}, {when}"}
    usual = f"usually every {gap} days" if gap and gap <= REGULAR_MAX_GAP else "now and then"
    return {"badge": "unsure", "label": "Not sure", "detail": f"Bought {usual}, {when}"}
