"""The MCP server at /mcp: Claude's tools, called as an MCP client would."""

import datetime as dt
import json

from fastapi.testclient import TestClient

from app.main import create_app
from test_api import trip, upload

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


class Mcp:
    def __init__(self, client: TestClient, token: str = ""):
        self.client, self.token, self.n = client, token, 0

    def rpc(self, method: str, params: dict | None = None):
        self.n += 1
        headers = {**HEADERS, **({"Authorization": f"Bearer {self.token}"} if self.token else {})}
        return self.client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}})

    def call(self, tool: str, **arguments):
        r = self.rpc("tools/call", {"name": tool, "arguments": arguments})
        assert r.status_code == 200, r.text
        result = r.json()["result"]
        if result["isError"]:
            return result
        if "structuredContent" in result:
            return result["structuredContent"].get("result", result["structuredContent"])
        return json.loads(result["content"][0]["text"])  # a plain dict comes back as JSON text


def shop(tmp_path, **kw):
    app = create_app(db_path=str(tmp_path / "t.db"), static_dir=str(tmp_path / "none"),
                     today=lambda: dt.date(2026, 10, 15), **kw)
    return app


def test_mcp_tools(tmp_path):
    with TestClient(shop(tmp_path)) as c:
        days = ["09-05", "09-12", "09-19", "09-26", "10-03", "10-10"]
        upload(c, {"purchases": [trip(f"2026-{d} 11:00:00", [("Tesco Whole Milk 2L", 1, 2.19), ("Brennans Family Pan 800g", 1, 2.5)] +
                                      ([("Kerrygold Butter 227g", 1, 3.9)] if n % 2 else [])) for n, d in enumerate(days)]})
        m = Mcp(c)
        tools = [t["name"] for t in m.rpc("tools/list").json()["result"]["tools"]]
        assert {"next_shop", "add_to_list", "before_you_order", "basket_list", "record_basket_results"} <= set(tools)

        plan = m.call("next_shop")
        assert plan["shop"]["date"] == "2026-10-17"
        assert {i["name"] for i in plan["to_get"]} == {"Tesco Whole Milk 2L", "Brennans Family Pan 800g"}
        assert m.call("add_to_list", name="Birthday candles") == "Birthday candles ×1 is on the list (Other)."

        # Butter's on half the shops but not due: flagged before ordering
        before = m.call("before_you_order")
        assert [r["name"] for r in before["regulars_not_on_it"]] == ["Kerrygold Butter 227g"]

        # Take something off and put it back
        assert m.call("take_off_next_shop", name="brennans") == "Took Brennans Family Pan 800g off the next shop."
        assert m.call("next_shop")["taken_off"] == ["Brennans Family Pan 800g"]
        assert m.call("put_back_on_next_shop", name="Brennans Family Pan 800g") == "Brennans Family Pan 800g is back on the next shop."
        assert m.call("take_off_next_shop", name="caviar")["isError"]

        # Fill a basket and record it
        basket = m.call("basket_list", store="tesco")
        assert basket["store"] == "Tesco" and {i["name"] for i in basket["items"]} == {"Tesco Whole Milk 2L", "Brennans Family Pan 800g", "Birthday candles"}
        assert all(i.get("product_url") is None for i in basket["items"])
        done = m.call("record_basket_results", store="tesco", total="€4.69", results=[
            {"item": "Tesco Whole Milk 2L", "status": "added", "product": "Tesco Whole Milk 2L", "url": "https://www.tesco.ie/shop/en-IE/products/123456", "qty": 1},
            {"item": "Brennans Family Pan 800g", "status": "missing", "note": "out of stock"},
        ])
        assert done["counts"] == {"added": 1, "swapped": 0, "missing": 1}
        assert done["missing"] == ["Brennans Family Pan 800g"] and done["not_mentioned"] == ["Birthday candles"]
        # The milk's product is saved, so the next basket goes straight to it
        milk = next(i for i in m.call("basket_list", store="tesco")["items"] if i["name"] == "Tesco Whole Milk 2L")
        assert milk["product_url"] == "https://www.tesco.ie/shop/en-IE/products/123456"

        history = m.call("item_history", name="whole milk")
        assert history["summary"]["trips"] == 6 and history["spent_eur"] == 13.14
        assert m.call("spending")["trips"] == 6
        assert m.call("find_items", query="butter")[0]["name"] == "Kerrygold Butter 227g"


def test_mcp_token(tmp_path):
    with TestClient(shop(tmp_path, mcp_token="s3cret")) as c:
        assert c.get("/api/mcp").json() == {"path": "/mcp", "token_required": True}
        assert Mcp(c).rpc("tools/list").status_code == 401
        assert Mcp(c, token="wrong").rpc("tools/list").status_code == 401
        assert Mcp(c, token="s3cret").rpc("tools/list").status_code == 200
        # Or in the address, for clients that can't send headers
        r = c.post("/mcp?token=s3cret", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 200
