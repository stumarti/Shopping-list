import datetime

from app.stats import group_suggestions, item_stats, suggestion

TODAY = datetime.date(2026, 10, 17)


def bought(*days, qty=1):
    """Purchases on these dates (days before TODAY), oldest first."""
    rows = []
    for n, d in enumerate(sorted(days, reverse=True)):
        day = (TODAY - datetime.timedelta(days=d)).isoformat()
        rows.append({"store": "tesco", "order_ref": f"t{n}-{day}", "bought_on": day, "qty": qty, "unit_price": None})
    return item_stats(rows)


def test_weekly_and_due_is_will():
    assert suggestion(bought(7, 14, 21, 28), TODAY) == ("will", "About every week, last 7 days ago")


def test_weekly_bought_three_days_ago_is_not_suggested():
    assert suggestion(bought(3, 10, 17, 24), TODAY) is None


def test_coming_up_is_might():
    # every 14 days, last bought 10 days ago: 70% of the way
    assert suggestion(bought(10, 24, 38, 52), TODAY) == ("might", "Usually every 14 days, last 10 days ago")


def test_uneven_but_due_is_might():
    s = bought(12, 15, 30, 33, 48)
    assert s["unevenness"] > 0.5
    assert suggestion(s, TODAY)[0] == "might"


def test_stopped_buying_is_not_suggested():
    assert suggestion(bought(60, 67, 74, 81), TODAY) is None


def test_occasional_is_extras():
    assert suggestion(bought(20, 95), TODAY) == ("extras", "Now and then: 2 times, last 20 days ago")
    # monthly-ish but slower than every 6 weeks: extras too
    assert suggestion(bought(10, 70, 130, 190), TODAY)[0] == "extras"
    # once only, or not for over a year: nothing
    assert suggestion(bought(5), TODAY) is None
    assert suggestion(bought(400, 500), TODAY) is None


def test_grouping_orders_and_quantities():
    items = [
        {"name": "Milk", **bought(9, 16, 23, 30, qty=2)},   # 9/7 through its gap: most overdue
        {"name": "Bread", **bought(7, 14, 21, 28)},
        {"name": "Nappies", **bought(10, 24, 38, 52)},
        {"name": "Wine", **bought(20, 95)},
        {"name": "Cake", **bought(30, 200, 300)},
    ]
    g = group_suggestions(items, TODAY)
    assert [i["name"] for i in g["will"]] == ["Milk", "Bread"]
    assert g["will"][0]["qty"] == 2
    assert [i["name"] for i in g["might"]] == ["Nappies"]
    assert [i["name"] for i in g["extras"]] == ["Cake", "Wine"]


def test_next_expected():
    s = bought(7, 14, 21, 28)
    assert s["next_expected"] == TODAY.isoformat()  # last a week ago, bought weekly
    assert bought(5)["next_expected"] is None


def test_weekly_counts_from_first_purchase():
    from app.stats import weekly
    rows = [
        {"store": "tesco", "order_ref": "a", "bought_on": "2026-09-29", "qty": 2},  # Tue, week of 28 Sep
        {"store": "tesco", "order_ref": "b", "bought_on": "2026-10-04", "qty": 1},  # Sun, same week
        {"store": "tesco", "order_ref": "c", "bought_on": "2026-10-13", "qty": 1},  # week of 12 Oct
    ]
    assert weekly(rows, TODAY) == [  # TODAY is Sat 17 Oct 2026
        {"week": "2026-09-28", "qty": 3, "trips": 2},
        {"week": "2026-10-05", "qty": 0, "trips": 0},
        {"week": "2026-10-12", "qty": 1, "trips": 1},
    ]
    long_ago = [{"store": "t", "order_ref": "x", "bought_on": "2024-01-01", "qty": 1}]
    assert len(weekly(long_ago, TODAY)) == 52 and weekly([], TODAY)[-1]["week"] == "2026-10-12"


def test_shop_date_on_usual_day():
    from app.stats import shop_plan_date
    # Saturdays, weekly; last shop Sat 10 Oct, today Sat 17 Oct
    sats = ["2026-09-19", "2026-09-26", "2026-10-03", "2026-10-10"]
    p = shop_plan_date(sats, TODAY)
    assert p == {"date": "2026-10-17", "every_days": 7, "last_shop": "2026-10-10",
                 "reason": "You usually shop on Saturdays, about every week"}
    # Shopped today already: next is a week on
    assert shop_plan_date(sats + ["2026-10-17"], TODAY)["date"] == "2026-10-24"
    # Overdue: never in the past, moved to the next Saturday on or after today
    assert shop_plan_date(["2026-08-01", "2026-08-08", "2026-08-15"], datetime.date(2026, 10, 14))["date"] == "2026-10-17"
    # No pattern of days: just the gap
    p = shop_plan_date(["2026-10-01", "2026-10-11"], TODAY)
    assert p["date"] == "2026-10-21" and p["reason"] == "You usually shop about every 10 days"
    assert shop_plan_date([], TODAY) is None


def test_what_goes_on_the_next_shop():
    from app.stats import for_next_shop
    shop = datetime.date(2026, 10, 24)  # a week from TODAY, shopping weekly
    weekly = {"name": "Milk", **bought(7, 14, 21, 28)}  # due today
    assert for_next_shop(weekly, shop, 7, TODAY) == {"badge": "weekly", "label": "Weekly", "detail": "Last bought 10 Oct, due Sat 17 Oct"}
    fortnightly_due = {"name": "Bananas", **bought(10, 24, 38, 52)}  # due in 4 days
    assert for_next_shop(fortnightly_due, shop, 7, TODAY)["label"] == "Every 2 weeks"
    assert for_next_shop(fortnightly_due, shop, 7, TODAY)["badge"] == "scheduled"
    fortnightly_just_bought = {"name": "Bread", **bought(1, 15, 29, 43)}  # due in 13 days: the shop after
    assert for_next_shop(fortnightly_just_bought, shop, 7, TODAY) is None
    uneven = {"name": "Wine", **bought(9, 12, 27, 30, 45)}
    assert for_next_shop(uneven, shop, 7, TODAY)["badge"] == "unsure"
    stopped = {"name": "Formula", **bought(60, 67, 74, 81)}
    assert for_next_shop(stopped, shop, 7, TODAY) is None
    twice = {"name": "Cake", **bought(10, 20)}
    assert for_next_shop(twice, shop, 7, TODAY) is None  # needs three trips to tell
