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
