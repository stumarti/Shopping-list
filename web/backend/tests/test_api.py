import os

os.environ["SHOPPING_NO_AUTOAPP"] = "1"

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


# A few common items for the tests to work with (the app itself starts with none).
SEED = {
    "Toiletries": "Toothpaste",
    "Fruit & veg": "Bananas\nApples",
    "Dairy & eggs": "Milk\nButter",
    "Bakery": "Sliced pan",
    "Household": "Toilet roll",
}


@pytest.fixture
def bare(tmp_path):
    return TestClient(create_app(db_path=str(tmp_path / "test.db"), static_dir=str(tmp_path / "none")))


@pytest.fixture
def client(bare):
    for aisle, names in SEED.items():
        bare.post("/api/catalog/bulk", json={"text": names, "category": aisle})
    return bare


def test_starts_with_no_common_items(bare):
    assert bare.get("/api/catalog").json() == []
    assert bare.get("/api/categories").json()[0] == "Fruit & veg"


def test_catalog_is_in_aisle_order(client):
    items = client.get("/api/catalog").json()
    assert [i["name"] for i in items] == ["Apples", "Bananas", "Sliced pan", "Butter", "Milk", "Toilet roll", "Toothpaste"]


def test_add_twice_bumps_quantity(client):
    first = client.post("/api/list", json={"name": "Milk", "category": "Dairy & eggs"}).json()
    again = client.post("/api/list", json={"name": "milk", "category": "Dairy & eggs", "qty": 2}).json()
    assert again["id"] == first["id"]
    assert again["qty"] == 3
    assert len(client.get("/api/list").json()) == 1


def test_typed_item_becomes_a_common_item(client):
    r = client.post("/api/list", json={"name": "  oat   milk ", "category": "Dairy & eggs"})
    assert r.status_code == 201
    assert r.json()["name"] == "Oat milk"
    catalog = client.get("/api/catalog").json()
    assert any(i["name"] == "Oat milk" and i["custom"] for i in catalog)


def test_unknown_category_goes_to_other(client):
    r = client.post("/api/list", json={"name": "Batteries", "category": "Gadgets"})
    assert r.json()["category"] == "Other"


def test_tick_change_qty_and_clear(client):
    a = client.post("/api/list", json={"name": "Bread", "category": "Bakery"}).json()
    b = client.post("/api/list", json={"name": "Eggs", "category": "Dairy & eggs"}).json()
    assert client.patch(f"/api/list/{a['id']}", json={"done": True}).json()["done"] is True
    assert client.patch(f"/api/list/{b['id']}", json={"qty": 12}).json()["qty"] == 12
    # A ticked item doesn't absorb a new add: it's a fresh line.
    c = client.post("/api/list", json={"name": "Bread", "category": "Bakery"}).json()
    assert c["id"] != a["id"]
    assert client.post("/api/list/clear-done").json() == {"removed": 1}
    assert {i["name"] for i in client.get("/api/list").json()} == {"Bread", "Eggs"}


def test_validation(client):
    assert client.post("/api/list", json={"name": "   "}).status_code == 422
    assert client.post("/api/list", json={"name": "Milk", "qty": 0}).status_code == 422
    assert client.patch("/api/list/999", json={"done": True}).status_code == 404


def test_catalog_add_and_remove(client):
    r = client.post("/api/catalog", json={"name": "Sourdough", "category": "Bakery"})
    assert r.status_code == 201
    assert client.post("/api/catalog", json={"name": "sourdough"}).status_code == 409
    assert client.delete(f"/api/catalog/{r.json()['id']}").status_code == 204
    assert not any(i["name"] == "Sourdough" for i in client.get("/api/catalog").json())


def test_serves_the_react_app(tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<div id=root></div>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(static)))
    assert "root" in c.get("/").text
    assert "root" in c.get("/some/page").text
    assert c.get("/assets/app.js").text == "console.log(1)"
    assert c.get("/api/nope").status_code == 404
    assert c.get("/../../etc/passwd").status_code in (200, 404)
    assert "root:" not in c.get("/%2e%2e/%2e%2e/etc/passwd").text


# Barcodes, store links and building the common items


def fake_open_facts(products: dict[str, dict]):
    """A stand-in for the Open Facts APIs: {host fragment + barcode: product}."""
    calls = []

    def fetch(url: str):
        calls.append(url)
        for key, product in products.items():
            host, code = key.split(":")
            if host in url and f"/product/{code}.json" in url:
                return {"status": 1, "product": product}
        return {"status": 0}

    fetch.calls = calls
    return fetch


def make(tmp_path, fetch):
    return TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"), fetch=fetch))


def test_barcode_found_in_open_food_facts(tmp_path):
    fetch = fake_open_facts({
        "openfoodfacts:5391528370313": {
            "product_name": "Low Low Light Spread", "brands": "Kerry, Low Low", "quantity": "500 g",
            "categories_tags": ["en:dairies", "en:spreads"],
        }
    })
    c = make(tmp_path, fetch)
    r = c.get("/api/barcode/5391528370313").json()
    assert r == {
        "barcode": "5391528370313", "name": "Low Low Light Spread", "brand": "Kerry",
        "quantity": "500 g", "category": "Dairy & eggs", "source": "openfoodfacts",
    }


def test_barcode_falls_through_to_sister_databases(tmp_path):
    fetch = fake_open_facts({"openbeautyfacts:12345678": {"product_name": "Mint toothpaste", "categories_tags": []}})
    r = make(tmp_path, fetch).get("/api/barcode/12345678").json()
    assert r["name"] == "Mint toothpaste" and r["category"] == "Toiletries" and r["source"] == "openbeautyfacts"


def test_barcode_unknown_unreachable_and_invalid(tmp_path):
    assert make(tmp_path, fake_open_facts({})).get("/api/barcode/00000000").status_code == 404

    def down(url):
        raise OSError("no network")

    r = make(tmp_path, down).get("/api/barcode/00000000")
    assert r.status_code == 502 and "Type the name" in r.json()["detail"]
    assert make(tmp_path, down).get("/api/barcode/12ab").status_code == 422


def test_barcode_is_remembered(tmp_path):
    fetch = fake_open_facts({})
    c = make(tmp_path, fetch)
    c.post("/api/list", json={"name": "Barry's tea", "category": "Breakfast", "barcode": "5391501610010"})
    assert any(i["barcode"] == "5391501610010" for i in c.get("/api/catalog").json())
    r = c.get("/api/barcode/5391501610010").json()
    assert r["name"] == "Barry's tea" and r["source"] == "yours"
    assert fetch.calls == []
    # Adding by name again carries the barcode onto the list line.
    c.post("/api/list/clear-done")
    item = c.post("/api/list", json={"name": "barry's tea"}).json()
    assert item["barcode"] == "5391501610010"


def test_links(client):
    links = client.get("/api/links").json()
    assert [s["name"] for s in links["stores"]] == ["Tesco", "Dunnes"]
    assert links["stores"][0]["search"] == "https://www.tesco.ie/shop/en-IE/search?query={q}"
    assert links["stores"][1]["search"] == "https://www.dunnesstoresgrocery.com/results?q={q}"
    assert "{code}" in links["barcodes"]["product"] and "{q}" in links["barcodes"]["search"]


def test_store_links_can_be_overridden(tmp_path, monkeypatch):
    monkeypatch.setenv("DUNNES_SEARCH_URL", "https://example.ie/s?q={q}")
    links = make(tmp_path, fake_open_facts({})).get("/api/links").json()
    assert links["stores"][1]["search"] == "https://example.ie/s?q={q}"


def test_bulk_add_common_items(client):
    r = client.post("/api/catalog/bulk", json={
        "text": "- kombucha\n\n  Oat milk \nmilk\n• kimchi\nkombucha",
        "category": "Fridge",
    }).json()
    assert r == {"added": ["Kombucha", "Oat milk", "Kimchi"], "skipped": ["Milk", "Kombucha"]}
    fridge = [i["name"] for i in client.get("/api/catalog").json() if i["category"] == "Fridge"]
    assert {"Kombucha", "Oat milk", "Kimchi"} <= set(fridge)


def test_edit_common_item(client):
    milk = next(i for i in client.get("/api/catalog").json() if i["name"] == "Milk")
    r = client.patch(f"/api/catalog/{milk['id']}", json={"name": "Avonmore milk", "barcode": "5391507540016"})
    assert r.json()["name"] == "Avonmore milk" and r.json()["barcode"] == "5391507540016"
    assert client.patch(f"/api/catalog/{milk['id']}", json={"name": "butter"}).status_code == 409
    assert client.patch(f"/api/catalog/{milk['id']}", json={"barcode": "123"}).status_code == 422
    assert client.patch(f"/api/catalog/{milk['id']}", json={"category": "Nowhere"}).json()["category"] == "Other"
    assert client.patch(f"/api/catalog/{milk['id']}", json={"barcode": ""}).json()["barcode"] == ""


def test_database_from_before_barcodes_is_upgraded(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript("""
        CREATE TABLE catalog (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
                              custom INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE list_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0,
            added_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO catalog (name, category) VALUES ('Milk', 'Dairy & eggs');
        INSERT INTO catalog (name, category, custom) VALUES ('Kombucha', 'Fridge', 1);
        INSERT INTO list_items (name, category) VALUES ('Milk', 'Dairy & eggs');
    """)
    old.commit()
    old.close()
    c = TestClient(create_app(db_path=str(path), static_dir=str(tmp_path / "none")))
    assert c.get("/api/list").json()[0]["barcode"] == ""
    # The old starter items go; your own stay, and so does the list
    assert [i["name"] for i in c.get("/api/catalog").json()] == ["Kombucha"]
    assert [i["name"] for i in c.get("/api/list").json()] == ["Milk"]


# Saved store products and the basket


def test_save_store_products(client):
    milk = next(i for i in client.get("/api/catalog").json() if i["name"] == "Milk")
    r = client.put(f"/api/catalog/{milk['id']}/products/tesco",
                   json={"url": "www.tesco.ie/shop/en-IE/products/250000750?ref=x", "title": " Avonmore  Milk "})
    assert r.status_code == 200
    assert r.json()["products"]["tesco"] == {"url": "https://www.tesco.ie/shop/en-IE/products/250000750", "title": "Avonmore Milk"}
    dunnes = "https://www.dunnesstoresgrocery.com/product/dunnes-stores-irish-skimmed-milk-1l-id-100806902"
    assert client.put(f"/api/catalog/{milk['id']}/products/dunnes", json={"url": dunnes}).status_code == 200
    # Wrong store, not a product, unknown store
    bad = client.put(f"/api/catalog/{milk['id']}/products/tesco", json={"url": dunnes})
    assert bad.status_code == 422 and "isn't a Tesco link" in bad.json()["detail"]
    assert client.put(f"/api/catalog/{milk['id']}/products/tesco",
                      json={"url": "https://www.tesco.ie/shop/en-IE/search?query=milk"}).status_code == 422
    assert client.put(f"/api/catalog/{milk['id']}/products/aldi", json={"url": dunnes}).status_code == 404
    # The list shows them, and forgetting one leaves the other
    client.post("/api/list", json={"name": "milk"})
    assert set(client.get("/api/list").json()[0]["products"]) == {"tesco", "dunnes"}
    assert set(client.delete(f"/api/catalog/{milk['id']}/products/tesco").json()["products"]) == {"dunnes"}
    # Deleting the common item takes its products with it
    client.delete(f"/api/catalog/{milk['id']}")
    assert client.get("/api/list").json()[0]["products"] == {}


def test_basket_and_linking_from_the_store(client):
    milk = client.post("/api/list", json={"name": "Milk", "qty": 2}).json()
    bread = client.post("/api/list", json={"name": "Sliced pan"}).json()
    done = client.post("/api/list", json={"name": "Eggs"}).json()
    client.patch(f"/api/list/{done['id']}", json={"done": True})

    r = client.post("/api/basket/tesco/link", json={
        "item_id": milk["id"], "url": "https://www.tesco.ie/shop/en-IE/products/111", "title": "Avonmore Milk 2L"})
    assert r.status_code == 200

    basket = client.get("/api/basket/tesco").json()
    assert basket["name"] == "Tesco"
    items = {i["name"]: i for i in basket["items"]}
    assert set(items) == {"Milk", "Sliced pan"}  # ticked items aren't bought again
    assert items["Milk"]["qty"] == 2
    assert items["Milk"]["product"] == {"url": "https://www.tesco.ie/shop/en-IE/products/111", "title": "Avonmore Milk 2L"}
    assert items["Sliced pan"]["product"] is None
    assert items["Sliced pan"]["search"] == "https://www.tesco.ie/shop/en-IE/search?query=Sliced%20pan"
    assert client.get("/api/basket/dunnes").json()["items"][0]["product"] is None
    assert client.get("/api/basket/aldi").status_code == 404

    # A list item whose common item was deleted gets a new one when linked
    catalog_id = next(i["id"] for i in client.get("/api/catalog").json() if i["name"] == "Sliced pan")
    client.delete(f"/api/catalog/{catalog_id}")
    r = client.post("/api/basket/dunnes/link", json={
        "item_id": bread["id"], "url": "https://www.dunnesstoresgrocery.com/product/brennans-family-pan-800g-id-100123456"})
    assert r.status_code == 200 and r.json()["name"] == "Sliced pan"


def test_userscript_is_served_for_this_server(client, monkeypatch):
    r = client.get("/userscript/shopping-list.user.js", headers={"host": "unraid.lan:8080"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/javascript")
    assert 'const SERVER = "http://unraid.lan:8080"' in r.text
    assert "@connect      unraid.lan" in r.text
    monkeypatch.setenv("PUBLIC_URL", "https://shop.example.ts.net/")
    r = client.get("/userscript/shopping-list.user.js")
    assert 'const SERVER = "https://shop.example.ts.net"' in r.text
    assert "@updateURL    https://shop.example.ts.net/userscript/shopping-list.user.js" in r.text


def test_health_reports_version(client, monkeypatch):
    assert client.get("/api/health").json() == {"ok": True, "version": "dev"}


# Importing past orders


TESCO = "https://www.tesco.ie/shop/en-IE/products/"


def test_import_order_builds_common_items_with_products(client):
    order = {
        "order_ref": "order-123",
        "date": "2026-09-12",
        "items": [
            {"name": "Avonmore Fresh Milk 2 Litre", "qty": 2, "url": TESCO + "111"},
            {"name": "Birds Eye Frozen Garden Peas 800g", "qty": 1, "url": TESCO + "222?from=order"},
            {"name": "Milk", "qty": 1, "url": TESCO + "333"},  # matches the existing "Milk" by name
            {"name": "Not a product", "qty": 1, "url": "https://www.tesco.ie/shop/en-IE/search?query=x"},
        ],
    }
    r = client.post("/api/history/tesco/import", json=order).json()
    assert r == {"order_ref": "order-123", "bought_on": "2026-09-12", "products": 3, "new_common_items": 2,
                 "skipped": 1, "already_imported": False}
    catalog = {i["name"]: i for i in client.get("/api/catalog").json()}
    assert catalog["Avonmore Fresh Milk 2 Litre"]["category"] == "Dairy & eggs"
    assert catalog["Avonmore Fresh Milk 2 Litre"]["products"]["tesco"]["url"] == TESCO + "111"
    assert catalog["Birds Eye Frozen Garden Peas 800g"]["category"] == "Frozen"
    assert catalog["Milk"]["products"]["tesco"] == {"url": TESCO + "333", "title": "Milk"}

    # The same order again changes nothing
    again = client.post("/api/history/tesco/import", json=order).json()
    assert again["products"] == 0 and again["already_imported"] is True
    assert len(client.get("/api/catalog").json()) == len(catalog)


def test_history_and_usual_items(client):
    for ref, date, items in [
        ("a", "2026-08-01", [("Avonmore Milk", 2, "111"), ("Sliced pan", 1, "222")]),
        ("b", "2026-08-08", [("Avonmore Milk", 2, "111")]),
        ("c", "2026-08-15", [("Avonmore Milk", 1, "111"), ("Tayto Crisps", 1, "444")]),
    ]:
        client.post("/api/history/tesco/import", json={
            "order_ref": ref, "date": date,
            "items": [{"name": n, "qty": q, "url": TESCO + u} for n, q, u in items]})
    h = client.get("/api/history").json()
    assert [o["order_ref"] for o in h["orders"]] == ["c", "b", "a"]
    assert h["orders"][2] == {"store": "tesco", "order_ref": "a", "bought_on": "2026-08-01", "products": 2, "units": 3,
                              "source": "order"}
    top = h["usual"][0]
    assert (top["name"], top["orders"], top["last_bought"], top["usual_qty"]) == ("Avonmore Milk", 3, "2026-08-15", 1.7)
    # A product saved before (by link) is recognised even under a different name in a later order
    client.post("/api/history/tesco/import", json={"order_ref": "d", "date": "2026-08-22",
                                                   "items": [{"name": "Avonmore Fresh Milk 1L", "url": TESCO + "111"}]})
    assert client.get("/api/history").json()["usual"][0]["orders"] == 4


def test_import_rejects_unknown_store_and_bad_dates_default_to_today(client):
    assert client.post("/api/history/aldi/import", json={"order_ref": "x", "items": [
        {"name": "Milk", "url": TESCO + "1"}]}).status_code == 404
    r = client.post("/api/history/tesco/import", json={"order_ref": "x", "date": "Saturday", "items": [
        {"name": "Milk", "url": TESCO + "1"}]}).json()
    import datetime
    assert r["bought_on"] == datetime.date.today().isoformat()


def test_adding_a_known_item_without_an_aisle_uses_its_aisle(client):
    assert client.post("/api/list", json={"name": "bananas"}).json()["category"] == "Fruit & veg"
    assert client.post("/api/list", json={"name": "Gadget"}).json()["category"] == "Other"


# Tesco's Clubcard data export, how often things are bought, and what they cost


def trip(ts, items, gross=None, kind="IN_STORE"):
    t = {"timestamp": ts, "type": kind, "says": "No", "numberOfItems": len(items),
         "payment": [{"type": "card", "category": "MastercardDebit", "amount": 1.0}],
         "items": [{"name": n, "quantity": q, "weight": 0.0, "price": p, "volume": float(q)} for n, q, p in items]}
    if gross is not None:
        t["basketValueGross"] = gross
    return t


def upload(client, data, raw=None):
    import json as _json
    return client.post("/api/history/tesco/clubcard", content=raw if raw is not None else _json.dumps(data),
                       headers={"content-type": "application/octet-stream"})


EXPORT = {"requestId": "x", "purchases": [
    trip("2026-09-28 10:02:11.120", [("Tesco Whole Milk 2L", 1, 2.19), ("Brennans Family Pan 800g", 1, 2.50),
                                     ("Bag For Life", 1, 0.70)], gross=5.39),
    trip("2026-10-05 11:15:00.000", [("Tesco Whole Milk 2L", 2, 2.29), ("Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack", 2, 10.0)],
         gross=24.58),
    trip("2026-10-12 15:20:43.586", [("Tesco Whole Milk 2L", 1, 2.39), ("Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack", 2, 20.0),
                                     ("F&F Baby Touch Fastening Pre Walker Trainers in White", 1, 12.5)], gross=34.89),
]}


def test_clubcard_import(client):
    r = upload(client, EXPORT).json()
    assert r.pop("saved_as").startswith("tesco-clubcard-")
    assert r == {"trips": 3, "new_trips": 3, "already_imported": 0, "lines": 6, "new_common_items": 2,
                 "not_groceries": 2, "from": "2026-09-28", "to": "2026-10-12"}
    names = {i["name"]: i for i in client.get("/api/catalog").json()}
    # Bought on two or more trips → a common item, with its aisle guessed. One-offs and clothing aren't.
    assert names["Tesco Whole Milk 2L"]["category"] == "Dairy & eggs"
    assert names["Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack"]["category"] == "Toiletries"
    assert "Brennans Family Pan 800g" not in names
    assert not any(n.startswith("F&F") or n == "Bag For Life" for n in names)
    # Uploading the same file again adds nothing
    again = upload(client, EXPORT).json()
    assert again["new_trips"] == 0 and again["already_imported"] == 3 and again["lines"] == 0


def test_clubcard_frequency_prices_and_timeline(client):
    upload(client, EXPORT)
    usual = {u["name"]: u for u in client.get("/api/history").json()["usual"]}
    milk = usual["Tesco Whole Milk 2L"]
    assert (milk["orders"], milk["first_bought"], milk["last_bought"], milk["every_days"]) == (3, "2026-09-28", "2026-10-12", 7)
    assert milk["usual_qty"] == 1.3
    assert milk["price"] == {"now": 2.39, "now_on": "2026-10-12", "first": 2.19, "first_on": "2026-09-28",
                             "low": 2.19, "high": 2.39}
    # Trip 2's prices add up per item (2 × 2.29 + 2 × 10 = 24.58); trip 3's add up per line (2.39 + 20 + 12.5),
    # so the nappies cost 10.00 each both times.
    nappies = usual["Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack"]
    assert nappies["price"]["first"] == 10.0 and nappies["price"]["now"] == 10.0
    assert nappies["every_days"] is None  # needs three trips

    t = client.get(f"/api/history/items/{milk['catalog_id']}").json()
    assert [(p["bought_at"], p["qty"], p["unit_price"], p["source"]) for p in t["purchases"]] == [
        ("2026-09-28T10:02:11", 1, 2.19, "clubcard in store"),
        ("2026-10-05T11:15:00", 2, 2.29, "clubcard in store"),
        ("2026-10-12T15:20:43", 1, 2.39, "clubcard in store"),
    ]
    assert t["summary"]["every_days"] == 7


def test_clubcard_zip_odd_shapes_and_bad_files(client):
    import io, json as _json, zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Tesco/readme.txt", "hello")
        # purchases as a bare list of trips, with a weighed item (no count) and no basket total
        z.writestr("Tesco/purchases.json", _json.dumps([
            trip("2026-01-03 09:00:00", [("Loose Bananas", 0, 0.65), ("Tesco Whole Milk 2L", 1, 1.99)]),
            trip("2026-01-10 09:00:00", [("Loose Bananas", 0, 0.70)], kind="ONLINE"),
        ]))
    r = upload(client, None, raw=buf.getvalue()).json()
    assert r["trips"] == 2 and r["lines"] == 3 and r["new_common_items"] == 1
    h = client.get("/api/history").json()
    assert {o["source"] for o in h["orders"]} == {"clubcard in store", "clubcard online"}
    bananas = next(u for u in h["usual"] if u["name"] == "Loose Bananas")
    assert bananas["usual_qty"] == 1 and bananas["price"]["now"] == 0.7

    assert upload(client, None, raw=b"not json").status_code == 422
    assert "No shopping trips" in upload(client, {"requestId": "x", "purchases": []}).json()["detail"]


def test_online_order_prices(client):
    client.post("/api/history/tesco/import", json={"order_ref": "o1", "date": "2026-10-01", "items": [
        {"name": "Avonmore Milk 2L", "qty": 2, "url": TESCO + "111", "price": 4.38}]})
    u = client.get("/api/history").json()["usual"][0]
    assert u["price"]["now"] == 2.19


def test_clubcard_keeps_everything_in_the_file(tmp_path):
    import json as _json, sqlite3
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none")))
    export = {**EXPORT, "points": {"balance": 1234}, "purchases": EXPORT["purchases"] + [
        trip("2026-10-13 09:00:00", [("Tesco Whole Milk 2L", 1, 2.39), ("Tesco Whole Milk 2L", 1, 2.39)])]}
    raw = _json.dumps(export).encode()
    r = c.post("/api/history/tesco/clubcard", content=raw).json()

    # The upload itself, byte for byte (points, request id and all)
    saved = tmp_path / "imports" / r["saved_as"]
    assert saved.read_bytes() == raw

    db = sqlite3.connect(tmp_path / "t.db")
    trips = db.execute("SELECT ref, type, basket_gross, raw FROM clubcard_trips ORDER BY ref").fetchall()
    assert len(trips) == 4
    assert _json.loads(trips[0][3]) == export["purchases"][0]  # payment details included
    assert _json.loads(trips[0][3])["payment"][0]["category"] == "MastercardDebit"
    # Every line, groceries or not, and the same product twice in one trip stays two lines
    lines = db.execute("SELECT name, quantity, price, volume, grocery FROM clubcard_items ORDER BY trip_ref, line_no").fetchall()
    assert len(lines) == sum(len(p["items"]) for p in export["purchases"]) == 10
    assert ("F&F Baby Touch Fastening Pre Walker Trainers in White", 1.0, 12.5, 1.0, 0) in lines
    assert ("Bag For Life", 1.0, 0.7, 1.0, 0) in lines
    assert lines[-2:] == [("Tesco Whole Milk 2L", 1.0, 2.39, 1.0, 1)] * 2
    # Re-uploading keeps another copy of the file but doesn't duplicate trips or lines
    again = c.post("/api/history/tesco/clubcard", content=raw).json()
    assert again["saved_as"] != r["saved_as"] and (tmp_path / "imports" / again["saved_as"]).read_bytes() == raw
    assert db.execute("SELECT count(*) FROM clubcard_items").fetchone()[0] == 10


def test_history_suggestions(tmp_path):
    import datetime as dt
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"),
                              today=lambda: dt.date(2026, 10, 19)))
    upload(c, EXPORT)  # milk on 28 Sep, 5 Oct, 12 Oct: weekly, last a week ago
    s = c.get("/api/history").json()["suggestions"]
    assert [i["name"] for i in s["will"]] == ["Tesco Whole Milk 2L"]
    assert s["will"][0]["reason"] == "About every week, last 7 days ago" and s["will"][0]["qty"] == 1
    assert [i["name"] for i in s["extras"]] == ["Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack"]
    assert s["might"] == []


# Aisles


def test_aisles_rename_reorder_add_remove(client):
    aisles = client.get("/api/aisles").json()
    assert aisles[0]["name"] == "Fruit & veg" and aisles[-1] == {**aisles[-1], "name": "Other", "fallback": True}
    veg = aisles[0]
    assert veg["items"] == 2
    client.post("/api/list", json={"name": "Bananas"})

    # Rename: items and list lines move with it
    assert client.patch(f"/api/aisles/{veg['id']}", json={"name": "fresh produce"}).json()["name"] == "Fresh produce"
    assert next(i for i in client.get("/api/catalog").json() if i["name"] == "Bananas")["category"] == "Fresh produce"
    assert client.get("/api/list").json()[0]["category"] == "Fresh produce"
    assert client.patch(f"/api/aisles/{veg['id']}", json={"name": "bakery"}).status_code == 409
    # Guesses for imported products still land there after the rename
    r = client.post("/api/history/tesco/import", json={"order_ref": "x", "date": "2026-10-01",
                                                       "items": [{"name": "Tesco Organic Bananas 5 Pack", "url": TESCO + "9"}]})
    assert r.status_code == 200
    assert next(i for i in client.get("/api/catalog").json() if i["name"] == "Tesco Organic Bananas 5 Pack")["category"] == "Fresh produce"

    # Add: goes just before Other
    baby = client.post("/api/aisles", json={"name": "Baby"}).json()
    names = [a["name"] for a in client.get("/api/aisles").json()]
    assert names[-2:] == ["Baby", "Other"]
    assert client.post("/api/aisles", json={"name": "baby"}).status_code == 409

    # Reorder: Baby first; list and catalog follow the new order
    ids = [a["id"] for a in client.get("/api/aisles").json()]
    ids.remove(baby["id"])
    assert client.put("/api/aisles/order", json={"ids": [baby["id"], *ids]}).json()[0]["name"] == "Baby"
    assert client.put("/api/aisles/order", json={"ids": ids}).status_code == 422
    client.post("/api/catalog", json={"name": "Nappies", "category": "Baby"})
    assert client.get("/api/catalog").json()[0]["name"] == "Nappies"
    assert client.get("/api/categories").json()[0] == "Baby"

    # Remove: items move to the chosen aisle (or Other); Other itself can't go
    other = next(a for a in client.get("/api/aisles").json() if a["fallback"])
    toiletries = next(a for a in client.get("/api/aisles").json() if a["name"] == "Toiletries")
    client.delete(f"/api/aisles/{baby['id']}?move_to={toiletries['id']}")
    assert next(i for i in client.get("/api/catalog").json() if i["name"] == "Nappies")["category"] == "Toiletries"
    client.delete(f"/api/aisles/{toiletries['id']}")
    assert next(i for i in client.get("/api/catalog").json() if i["name"] == "Nappies")["category"] == "Other"
    assert client.delete(f"/api/aisles/{other['id']}").status_code == 409
    # Unknown aisles in requests go to Other, even after Other is renamed
    client.patch(f"/api/aisles/{other['id']}", json={"name": "Everything else"})
    assert client.post("/api/list", json={"name": "Batteries", "category": "Gadgets"}).json()["category"] == "Everything else"


# Finding barcodes by name


def off_search(results: dict[str, list[dict]]):
    """A pretend Open Food Facts search: {words in the query: products}."""
    calls = []

    def fetch(url):
        import urllib.parse as up
        calls.append(url)
        if "/cgi/search.pl" not in url or "openfoodfacts" not in url:
            return {"products": []}
        q = up.parse_qs(up.urlsplit(url).query)["search_terms"][0].lower()
        return {"products": results.get(q, [])}

    fetch.calls = calls
    return fetch


def test_find_barcodes(tmp_path):
    fetch = off_search({
        "avonmore fresh milk 2 litre": [
            {"code": "5391500000001", "product_name": "Low fat milk", "brands": "Avonmore", "quantity": "1 L"},
            {"code": "5391500000002", "product_name": "Fresh Milk", "brands": "Avonmore", "quantity": "2L",
             "countries_tags": ["en:ireland"]},
        ],
        "brennans family pan 800g": [{"code": "5099999999999", "product_name": "Wholemeal bread", "brands": "Pat the Baker"}],
    })
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"), fetch=fetch, search_gap=0))
    for n in ["Avonmore Fresh Milk 2 Litre", "Brennans Family Pan 800g"]:
        c.post("/api/catalog", json={"name": n, "category": "Dairy & eggs"})
    start = c.post("/api/barcodes/find", json={}).json()
    assert start["total"] == 2  # starter one-word items like "Milk" are skipped
    import time
    for _ in range(100):
        if not c.get("/api/barcodes/find").json()["running"]:
            break
        time.sleep(0.02)
    s = c.get("/api/barcodes/find").json()
    assert s["done"] == 2 and s["error"] is None
    assert s["found"] == [{"catalog_id": s["found"][0]["catalog_id"], "name": "Avonmore Fresh Milk 2 Litre",
                           "barcode": "5391500000002", "product": "Avonmore Fresh Milk 2L", "source": "openfoodfacts"}]
    items = {i["name"]: i for i in c.get("/api/catalog").json()}
    assert items["Avonmore Fresh Milk 2 Litre"]["barcode"] == "5391500000002"
    assert items["Avonmore Fresh Milk 2 Litre"]["barcode_source"] == "openfoodfacts"
    assert items["Brennans Family Pan 800g"]["barcode"] == ""  # wrong bread isn't assigned

    # Nothing left to try; undoing one marks it as yours, so it isn't searched again
    assert s["waiting"] == 0
    c.patch(f"/api/catalog/{items['Avonmore Fresh Milk 2 Litre']['id']}", json={"barcode": ""})
    assert c.post("/api/barcodes/find", json={}).json()["total"] == 0
    # "Try again" includes the ones that found nothing (and the undone one)
    assert c.post("/api/barcodes/find", json={"retry": True}).json()["total"] == 2


def test_find_barcodes_when_offline(tmp_path):
    def down(url):
        raise OSError("no network")
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"), fetch=down, search_gap=0))
    c.post("/api/catalog", json={"name": "Barrys Gold Blend Tea"})
    c.post("/api/barcodes/find", json={})
    import time
    for _ in range(100):
        if not c.get("/api/barcodes/find").json()["running"]:
            break
        time.sleep(0.02)
    s = c.get("/api/barcodes/find").json()
    assert "Couldn't reach Open Food Facts" in s["error"]
    assert s["waiting"] == 1  # not marked as tried, so it carries on next time


def test_clubcard_prices_default_to_per_item_when_totals_dont_add_up():
    from app.clubcard import prices_are_line_totals
    t = trip("2026-01-01 10:00", [("Milk", 2, 2.20), ("Bread", 1, 2.50)], gross=11.00)  # neither 6.90 nor 4.70
    assert prices_are_line_totals(t) is False
    assert prices_are_line_totals(trip("2026-01-01 10:00", [("Milk", 2, 4.40), ("Bread", 1, 2.50)], gross=6.90)) is True
    assert prices_are_line_totals(trip("2026-01-01 10:00", [("Milk", 2, 2.20), ("Bread", 1, 2.50)], gross=6.90)) is False


def test_clear_all_and_rebuild_from_history(client):
    upload(client, EXPORT)  # milk and nappies on 2+ trips; bread once
    client.post("/api/history/tesco/import", json={"order_ref": "o1", "date": "2026-10-14", "items": [
        {"name": "Avonmore Fresh Milk 2 Litre", "qty": 1, "url": TESCO + "111", "price": 2.19}]})
    client.post("/api/list", json={"name": "Milk"})
    before = len(client.get("/api/catalog").json())
    assert before > 3

    assert client.post("/api/catalog/clear").json() == {"removed": before}
    assert client.get("/api/catalog").json() == []
    assert [i["name"] for i in client.get("/api/list").json()] == ["Milk"]  # the list stays
    assert len(client.get("/api/history").json()["orders"]) == 4  # and the history

    r = client.post("/api/catalog/rebuild").json()
    names = {i["name"]: i for i in client.get("/api/catalog").json()}
    assert set(names) == {"Tesco Whole Milk 2L", "Pampers Baby Dry Size 4 Nappies Jumbo+ 84 Pack", "Avonmore Fresh Milk 2 Litre"}
    assert r == {"added": 3, "purchases": 6}
    assert names["Avonmore Fresh Milk 2 Litre"]["products"]["tesco"]["url"] == TESCO + "111"
    assert names["Tesco Whole Milk 2L"]["category"] == "Dairy & eggs"
    assert client.get("/api/history").json()["usual"][0]["name"] == "Tesco Whole Milk 2L"
    # Rebuilding again finds nothing new
    assert client.post("/api/catalog/rebuild").json() == {"added": 0, "purchases": 0}


def test_next_shop(tmp_path):
    import datetime as dt
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"),
                              today=lambda: dt.date(2026, 10, 15)))
    weekly = [trip(f"2026-{d} 11:00:00", [("Tesco Whole Milk 2L", 1, 2.19), ("Brennans Family Pan 800g", 1, 2.5)] +
                   ([("Loose Bananas", 1, 0.65)] if n % 2 == 0 else []))
              for n, d in enumerate(["09-05", "09-12", "09-19", "09-26", "10-03", "10-10"])]  # Saturdays
    upload(c, {"purchases": weekly})
    c.post("/api/list", json={"name": "Birthday candles", "category": "Other"})

    plan = c.get("/api/next-shop").json()
    assert plan["shop"]["date"] == "2026-10-17" and plan["shop"]["reason"] == "You usually shop on Saturdays, about every week"
    got = {i["name"]: (i["badge"], i["label"]) for i in plan["items"]}
    assert got == {
        "Brennans Family Pan 800g": ("weekly", "Weekly"),
        "Tesco Whole Milk 2L": ("weekly", "Weekly"),
        "Loose Bananas": ("scheduled", "Every 2 weeks"),  # last bought 3 Oct, so due on the 17th
        "Birthday candles": ("added", "Added"),
    }
    assert [i["category"] for i in plan["items"]] == ["Fruit & veg", "Bakery", "Dairy & eggs", "Other"]  # in aisle order

    # Take the bread off this shop, then put it back
    bread = next(i for i in plan["items"] if i["name"].startswith("Brennans"))
    after = c.post(f"/api/next-shop/skip/{bread['catalog_id']}").json()
    assert "Brennans Family Pan 800g" not in {i["name"] for i in after["items"]}
    assert [i["name"] for i in after["skipped"]] == ["Brennans Family Pan 800g"]
    back = c.delete(f"/api/next-shop/skip/{bread['catalog_id']}").json()
    assert "Brennans Family Pan 800g" in {i["name"] for i in back["items"]}

    # Nothing bought yet: no date, just what you added
    empty = TestClient(create_app(db_path=str(tmp_path / "e.db"), static_dir=str(tmp_path / "none"))).get("/api/next-shop").json()
    assert empty == {"shop": None, "items": [], "skipped": []}


def test_generic_items_pick_one_sets_and_calories(tmp_path):
    import datetime as dt
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"),
                              today=lambda: dt.date(2026, 10, 15)))
    trips = []
    for n, d in enumerate(["09-05", "09-12", "09-19", "09-26", "10-03", "10-10"]):  # Saturdays
        lines = [("Tesco Whole Milk 2L", 1, 2.19)]
        # Broccoli every week, but a different kind each time
        lines.append(("Tesco Tenderstem Broccoli 200g", 1, 2.0) if n % 2 == 0 else ("Tesco Broccoli Florets 360g", 1, 1.0))
        # Chicken one week, mince the next
        lines.append(("Tesco Chicken Breast Fillets 650g", 1, 6.0) if n % 2 == 0 else ("Tesco Beef Mince 500g", 1, 5.0))
        trips.append(trip(f"2026-{d} 11:00:00", lines))
    upload(c, {"purchases": trips})
    ids = {i["name"]: i["id"] for i in c.get("/api/catalog").json()}
    assert {i["name"]: i["trips"] for i in c.get("/api/catalog").json()}["Tesco Whole Milk 2L"] == 6

    # Two kinds of broccoli under one generic item
    for name in ["Tesco Tenderstem Broccoli 200g", "Tesco Broccoli Florets 360g"]:
        r = c.patch(f"/api/catalog/{ids[name]}", json={"group": "broccoli"})
        assert r.status_code == 200 and r.json()["group_id"]
    catalog = {i["name"]: i for i in c.get("/api/catalog").json()}
    broccoli = catalog["Broccoli"]
    assert broccoli["kind"] == "group" and broccoli["trips"] == 6
    assert catalog["Tesco Broccoli Florets 360g"]["trips"] == 3
    assert len(c.get(f"/api/history/items/{broccoli['id']}").json()["purchases"]) == 6

    # The next shop shows the generic item, weekly, instead of each kind every two weeks
    plan = c.get("/api/next-shop").json()
    got = {i["name"]: i for i in plan["items"]}
    assert got["Broccoli"]["label"] == "Weekly" and got["Broccoli"]["trips"] == 6
    assert not any("Tenderstem" in n or "Florets" in n for n in got)

    # Chicken or mince: one line, pick one
    chicken, mince = ids["Tesco Chicken Breast Fillets 650g"], ids["Tesco Beef Mince 500g"]
    assert c.patch(f"/api/catalog/{chicken}", json={"or_set": "Protein", "kcal": 650}).status_code == 200
    assert c.patch(f"/api/catalog/{mince}", json={"or_set": "protein", "kcal": 1100}).status_code == 200
    plan = c.get("/api/next-shop").json()
    protein = next(i for i in plan["items"] if i["name"] == "Protein")
    assert protein["kind"] == "or" and protein["chosen"] is None
    assert [(o["name"], o["due"]) for o in protein["options"]] == [
        ("Tesco Beef Mince 500g", False), ("Tesco Chicken Breast Fillets 650g", True)]  # chicken's due; mince was last week
    assert (protein["kcal_low"], protein["kcal_high"]) == (650, 1100)
    assert not any(i["name"].startswith(("Tesco Chicken", "Tesco Beef")) for i in plan["items"])

    after = c.post(f"/api/next-shop/choose/{protein['catalog_id']}", json={"catalog_id": mince}).json()
    protein = next(i for i in after["items"] if i["name"] == "Protein")
    assert protein["chosen"] == mince and (protein["kcal_low"], protein["kcal_high"]) == (1100, 1100)
    assert c.post(f"/api/next-shop/choose/{protein['catalog_id']}", json={"catalog_id": ids["Tesco Whole Milk 2L"]}).status_code == 422
    # Calories: a generic item without its own uses the average of its kinds
    c.patch(f"/api/catalog/{ids['Tesco Tenderstem Broccoli 200g']}", json={"kcal": 70})
    c.patch(f"/api/catalog/{ids['Tesco Broccoli Florets 360g']}", json={"kcal": 130})
    plan = c.get("/api/next-shop").json()
    assert next(i for i in plan["items"] if i["name"] == "Broccoli")["kcal_low"] == 100
    # Clearing calories
    assert c.patch(f"/api/catalog/{chicken}", json={"kcal": None}).json()["kcal"] is None

    # A kind can't join a set (its generic item can), and a set's name can't be an item's
    assert c.patch(f"/api/catalog/{ids['Tesco Broccoli Florets 360g']}", json={"or_set": "Protein"}).status_code == 409
    assert c.patch(f"/api/catalog/{ids['Tesco Whole Milk 2L']}", json={"or_set": "Broccoli"}).status_code == 409
    assert c.patch(f"/api/catalog/{ids['Tesco Whole Milk 2L']}", json={"group": "Protein"}).status_code == 409

    # The typical shop, aisle by aisle
    t = c.get("/api/typical-shop").json()
    assert t["trips"] == 6 and t["products"] == 3.0 and t["from"] == "2026-09-05"
    aisles = {a["aisle"]: a for a in t["aisles"]}
    assert aisles["Dairy & eggs"]["top"] == ["Tesco Whole Milk 2L"] and aisles["Dairy & eggs"]["spend"] == 2.19
    assert "Broccoli" in [n for a in t["aisles"] for n in a["top"]]

    # Taking the kinds out again: the generic item made only to hold them goes
    for name in ["Tesco Tenderstem Broccoli 200g", "Tesco Broccoli Florets 360g"]:
        c.patch(f"/api/catalog/{ids[name]}", json={"group": ""})
    names = {i["name"] for i in c.get("/api/catalog").json()}
    assert "Broccoli" not in names and "Protein" in names
    # Leaving a set empty removes it
    for i in (chicken, mince):
        c.patch(f"/api/catalog/{i}", json={"or_set": ""})
    assert "Protein" not in {i["name"] for i in c.get("/api/catalog").json()}
    assert c.get("/api/typical-shop").json()["trips"] == 6
    assert TestClient(create_app(db_path=str(tmp_path / "e.db"), static_dir=str(tmp_path / "none"))).get("/api/typical-shop").json() is None


def test_generic_item_from_an_existing_item(client):
    ids = {i["name"]: i["id"] for i in client.get("/api/catalog").json()}
    client.post("/api/catalog", json={"name": "Oat milk", "category": "Dairy & eggs"})
    oat = next(i for i in client.get("/api/catalog").json() if i["name"] == "Oat milk")
    # "Milk" already exists as an item, so it becomes the generic item
    assert client.patch(f"/api/catalog/{oat['id']}", json={"group": "Milk"}).json()["group_id"] == ids["Milk"]
    milk = next(i for i in client.get("/api/catalog").json() if i["name"] == "Milk")
    assert milk["kind"] == "group"
    assert client.patch(f"/api/catalog/{ids['Milk']}", json={"group": "Butter"}).status_code == 409  # it has kinds
    assert client.patch(f"/api/catalog/{oat['id']}", json={"group": "Oat milk"}).status_code == 422
    # Out again: Milk is a plain item, not deleted
    client.patch(f"/api/catalog/{oat['id']}", json={"group": ""})
    milk = next(i for i in client.get("/api/catalog").json() if i["name"] == "Milk")
    assert milk["kind"] == "item"
    # Deleting the only kind of a made-up generic item removes it too
    client.patch(f"/api/catalog/{oat['id']}", json={"group": "Plant milk"})
    client.delete(f"/api/catalog/{oat['id']}")
    assert "Plant milk" not in {i["name"] for i in client.get("/api/catalog").json()}


def test_item_history_works_out_timing_for_the_kind(tmp_path):
    import datetime as dt
    c = TestClient(create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"),
                              today=lambda: dt.date(2026, 10, 15)))
    # Broccoli every Saturday, alternating kinds: each kind alone looks fortnightly
    shops = []
    for n, d in enumerate(["09-05", "09-12", "09-19", "09-26", "10-03", "10-10"]):
        kind = ("Tesco Tenderstem Broccoli 200g", 1, 2.0 + n * 0.1) if n % 2 == 0 else ("Tesco Broccoli Florets 360g", 1, 1.0)
        shops.append(trip(f"2026-{d} 11:00:00", [kind, ("Tesco Whole Milk 2L", 1, 2.19)]))
    upload(c, {"purchases": shops})
    ids = {i["name"]: i["id"] for i in c.get("/api/catalog").json()}
    for name in ["Tesco Tenderstem Broccoli 200g", "Tesco Broccoli Florets 360g"]:
        c.patch(f"/api/catalog/{ids[name]}", json={"group": "broccoli"})
    broccoli = next(i["id"] for i in c.get("/api/catalog").json() if i["name"] == "Broccoli")

    # A kind: weekly, because broccoli is bought weekly; its own price and count
    t = c.get(f"/api/history/items/{ids['Tesco Tenderstem Broccoli 200g']}").json()
    assert t["kind"] == {"id": broccoli, "name": "Broccoli", "kinds": 2}
    assert t["summary"]["every_days"] == 7 and t["summary"]["trips"] == 6
    assert t["summary"]["next_expected"] == "2026-10-17"
    assert t["summary"]["price"]["low"] == 2.0 and t["summary"]["price"]["high"] == 2.4  # tenderstem only
    assert t["product"] == {"trips": 3, "last_bought": "2026-10-03"}
    assert [p["bought_as"] for p in t["purchases"]] == ["Tesco Tenderstem Broccoli 200g"] * 3
    assert sum(1 for w in t["weekly"] if w["qty"]) == 6  # the grid shows every broccoli week
    assert t["weekly"][-1]["kinds"] == ["Tesco Broccoli Florets 360g"] if t["weekly"][-1]["qty"] else True

    # The generic item: the same timing, prices split by kind instead of mixed
    g = c.get(f"/api/history/items/{broccoli}").json()
    assert g["summary"]["every_days"] == 7 and g["summary"]["price"] is None
    assert [(k["name"], k["trips"], k["price"]["now"]) for k in g["by_kind"]] == [
        ("Tesco Broccoli Florets 360g", 3, 1.0), ("Tesco Tenderstem Broccoli 200g", 3, 2.4)]
    assert len(g["purchases"]) == 6

    # An item with no kinds is unchanged
    m = c.get(f"/api/history/items/{ids['Tesco Whole Milk 2L']}").json()
    assert m["kind"] is None and m["by_kind"] == [] and m["product"] is None and m["summary"]["price"]["now"] == 2.19
