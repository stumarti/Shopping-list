import os

os.environ["SHOPPING_NO_AUTOAPP"] = "1"

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(db_path=str(tmp_path / "test.db"), static_dir=str(tmp_path / "none")))


def test_catalog_is_seeded_in_aisle_order(client):
    items = client.get("/api/catalog").json()
    names = [i["name"] for i in items]
    assert "Milk" in names and "Toilet roll" in names
    assert items[0]["category"] == "Fruit & veg"
    assert items[-1]["category"] == "Toiletries"


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
        INSERT INTO list_items (name, category) VALUES ('Milk', 'Dairy & eggs');
    """)
    old.commit()
    old.close()
    c = TestClient(create_app(db_path=str(path), static_dir=str(tmp_path / "none")))
    assert c.get("/api/list").json()[0]["barcode"] == ""
    assert [i["name"] for i in c.get("/api/catalog").json()] == ["Milk"]


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
            {"name": "Milk", "qty": 1, "url": TESCO + "333"},  # matches the starter "Milk" by name
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
    assert h["orders"][2] == {"store": "tesco", "order_ref": "a", "bought_on": "2026-08-01", "products": 2, "units": 3}
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
