import datetime

from app.stats import typical_shop, group_suggestions, item_stats, suggestion

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
    assert len(weekly(long_ago, TODAY)) == 146 and weekly([], TODAY)[-1]["week"] == "2026-10-12"  # all of it
    assert len(weekly(long_ago, TODAY, weeks=52)) == 52
    # A week with no shopping at all is marked, so it isn't read as "not bought"
    marked = weekly(rows, TODAY, shopped={"2026-09-28", "2026-10-12"})
    assert [w.get("shopped") for w in marked] == [True, False, None]  # this week isn't over, so it isn't marked


def test_spending():
    from app.stats import spending
    row = lambda pid, day, price, trip, qty=1: {"catalog_id": pid, "name": f"P{pid}", "bought_on": day, "qty": qty, "unit_price": price, "trip": trip}
    rows = [
        row(1, "2026-01-05", 2.0, "a"), row(2, "2026-01-05", 1.0, "a", qty=2),
        row(1, "2026-01-07", 2.0, "b"),
        row(1, "2026-06-01", 2.2, "c"), row(2, "2026-06-01", 1.0, "c", qty=2),
        row(3, "2026-06-01", None, "c"),  # no price: left out
    ]
    s = spending(rows, TODAY)
    assert s["total"] == 10.2 and s["trips"] == 3 and s["a_shop"] == 3.4
    assert s["weeks"] == 2 and s["a_week"] == 5.1  # two weeks with shopping, the months between don't count
    assert s["months"] == [{"month": "2026-01", "spend": 6.0, "trips": 2}, {"month": "2026-06", "spend": 4.2, "trips": 1}]
    # Milk up 10%, the other flat: overall up, weighted by spend (6.2 on P1, 4.0 on P2)
    assert s["prices"]["products"] == 2 and s["prices"]["change"] == round(0.1 * 6.2 / 10.2, 3)
    assert [c["name"] for c in s["prices"]["up"]] == ["P1"] and s["prices"]["down"] == []
    assert spending([row(1, "2026-01-05", None, "a")], TODAY) is None


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


def test_typical_shop_calories_a_week_skip_weeks_with_no_shopping():
    line = lambda trip, day, kcal: {"trip": trip, "day": day, "aisle": "Dairy & eggs", "name": "Milk", "qty": 1, "spend": 2.0, "kcal": kcal}
    # Two shops one week, one a fortnight later; the week between had no shopping and isn't counted
    t = typical_shop([line("a", "2026-10-05", 3000), line("b", "2026-10-09", 1000), line("c", "2026-10-21", 2000)], ["Dairy & eggs"])
    assert t["weeks"] == 2 and t["kcal_week"] == 3000
    assert t["kcal"] == 2000  # a shop


def test_food_group_guesses():
    from app.catalog import guess_food_group
    assert guess_food_group("Tesco Whole Milk 2L", "Dairy & eggs") == "dairy"
    assert guess_food_group("Cadbury Dairy Milk Chocolate", "Snacks & treats") == "treats"
    assert guess_food_group("Kerrygold Butter 227g", "Dairy & eggs") == "fats"
    assert guess_food_group("Whole Earth Peanut Butter", "Cupboard") == "protein"
    assert guess_food_group("Brennans Family Pan 800g", "Bakery") == "starch"
    assert guess_food_group("Loose Bananas", "Fresh produce") == "veg"
    assert guess_food_group("Fairy Original Washing Up Liquid", "Household") == ""
    assert guess_food_group("Something new", "Fruit & veg") == "veg"  # by aisle when no word says


def test_reading_claudes_results():
    import pytest
    from app.results import key, parse
    reply = """All done! Here's what I did.

```json
{"results": [
  {"item": "Tesco Whole Milk 2L", "status": "added", "product": "Tesco Whole Milk 2L", "url": "https://www.tesco.ie/x", "qty": 2},
  {"item": "Loose Bananas", "status": "Out of stock", "note": "none left"},
  {"item": "Bread", "status": "substituted", "product": "Pat the Baker", "qty": "1"}
], "total": "€9.20"}
```
Let me know if you'd like anything else."""
    r = parse(reply)
    assert [(i["item"], i["status"]) for i in r["items"]] == [
        ("Tesco Whole Milk 2L", "added"), ("Loose Bananas", "missing"), ("Bread", "swapped")]
    assert r["items"][0]["qty"] == 2 and r["items"][2]["qty"] == 1 and r["total"] == "€9.20"
    # Without a fence, and with curly quotes from a phone
    assert parse('Results: {“results”: [{“item”: “Eggs”, “status”: “added”}]}')["items"][0]["item"] == "Eggs"
    with pytest.raises(ValueError):
        parse("I added everything!")
    assert key("2 × Tesco Whole Milk 2L [exact: never swap]") == "tesco whole milk 2l"
