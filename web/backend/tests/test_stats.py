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
