"""An MCP server, so Claude (Claude Code, Claude Desktop, or claude.ai once the app is on https) can use the list:
what's on the next shop, add and take things off, look up items, prices and spending, and fill an online basket
and record how it went.

It's served by the same app at /mcp (streamable HTTP). Every tool calls the app's own API in-process, so the rules
and checks are the same as the page's. Set MCP_TOKEN to require it: send it as "Authorization: Bearer <token>"
or add ?token=<token> to the address. Without one, anyone who can reach the app can use it, as with the page.
"""

import contextlib
from collections.abc import Callable
import hmac
import json
import logging
import os

import httpx2
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import ToolAnnotations
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse
from starlette.routing import Route

INSTRUCTIONS = """This is the household's shopping list: the next shop (worked out from what they usually buy, and
when), common items with their usual products, prices and history, and spending.

To fill an online basket (Tesco or Dunnes) in the person's browser: call before_you_order first and ask about
anything it flags, then basket_list for the list with saved product links. Only ever add things to the basket:
never check out, pay, book or change a delivery slot, use vouchers, or change their account. Items marked
never_swap must not be swapped, even when out of stock. When you're done, call record_basket_results with one
entry for every item, so the app can show what's missing before they check out."""

# Each tool's call into the app is a request of its own; they'd fill the log.
logging.getLogger("httpx2").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)


class BasketResult(BaseModel):
    item: str = Field(description="The item's name exactly as basket_list gave it")
    status: str = Field(description='"added", "swapped" (something else went in instead) or "missing" (nothing added)')
    product: str = Field(default="", description="The product's name on the store's site")
    url: str = Field(default="", description="The product page of what was added")
    qty: float | None = Field(default=None, description="How many went in")
    note: str = Field(default="", description="Why it was swapped or is missing")


class RecordedLine(BaseModel):
    name: str = Field(description="What was bought, ideally a common item's name")
    qty: int = Field(default=1, description="How many")
    price: float | None = Field(default=None, description="Price each in euro, if known")


def _named(items: list[dict], name: str) -> dict | None:
    key = name.strip().lower()
    return next((i for i in items if i["name"].lower() == key), None) or next(
        (i for i in items if key in i["name"].lower()), None)


def build(app, token: str | None = None) -> tuple[Route, Callable[[], contextlib.AbstractAsyncContextManager]]:
    """The /mcp route, and the context to run it in while the app runs."""
    token = token if token is not None else os.environ.get("MCP_TOKEN", "")
    server = MCPServer("Press", instructions=INSTRUCTIONS, version=os.environ.get("APP_VERSION", "dev"))

    async def api(method: str, path: str, **kw):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://shopping-list") as client:
            r = await client.request(method, f"/api{path}", **kw)
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = None
            raise ToolError(detail if isinstance(detail, str) else f"The app said no ({r.status_code})")
        return r.json() if r.content else None

    def line(i: dict) -> dict:
        out = {"name": i["name"], "qty": i["qty"], "aisle": i["category"], "why": f'{i["label"]}: {i["detail"]}'}
        if i["kind"] == "or":
            out["pick_one_of"] = [o["name"] for o in i["options"] or []]
            out["picked"] = next((o["name"] for o in i["options"] or [] if o["catalog_id"] == i["chosen"]), None)
        return out

    @server.tool(annotations=READ)
    async def next_shop() -> dict:
        """When the next shop probably is, and everything on it: what's needed (with why), maybes (not sure
        they're needed; not on the shop unless added), and what was taken off this shop."""
        plan = await api("GET", "/next-shop")
        return {
            "shop": plan["shop"],
            "to_get": [line(i) for i in plan["items"]],
            "maybe": [line(i) for i in plan["maybe"]],
            "taken_off": [i["name"] for i in plan["skipped"]],
        }

    @server.tool(annotations=WRITE)
    async def add_to_list(name: str, qty: int = 1, aisle: str = "") -> str:
        """Add something to the next shop (or add to its quantity if it's already there). aisle is optional: a
        common item keeps its own, and new things are placed by their name."""
        item = await api("POST", "/list", json={"name": name, "qty": qty, "category": aisle})
        return f'{item["name"]} ×{item["qty"]} is on the list ({item["category"]}).'

    @server.tool(annotations=WRITE)
    async def take_off_next_shop(name: str) -> str:
        """Take something off the next shop. A usual item comes back for the shop after; something added by hand
        is removed from the list."""
        plan = await api("GET", "/next-shop")
        item = _named(plan["items"], name)
        if not item:
            raise ToolError(f"{name} isn't on the next shop")
        if item["catalog_id"] is not None:
            await api("POST", f'/next-shop/skip/{item["catalog_id"]}')
        else:
            await api("DELETE", f'/list/{item["list_item_id"]}')
        return f'Took {item["name"]} off the next shop.'

    @server.tool(annotations=WRITE)
    async def put_back_on_next_shop(name: str) -> str:
        """Put back something taken off the next shop."""
        plan = await api("GET", "/next-shop")
        item = _named(plan["skipped"], name)
        if not item:
            raise ToolError(f"{name} wasn't taken off the next shop")
        await api("DELETE", f'/next-shop/skip/{item["catalog_id"]}')
        return f'{item["name"]} is back on the next shop.'

    @server.tool(annotations=WRITE)
    async def pick_option(set_name: str, option: str) -> str:
        """For a pick-one set on the next shop (e.g. Protein: chicken or mince), pick the one to get this time."""
        plan = await api("GET", "/next-shop")
        item = _named([i for i in plan["items"] if i["kind"] == "or"], set_name)
        if not item:
            raise ToolError(f"There's no pick-one set called {set_name} on the next shop")
        chosen = _named(item["options"] or [], option)
        if not chosen:
            raise ToolError(f'{option} isn\'t one of {item["name"]}\'s options: {", ".join(o["name"] for o in item["options"] or [])}')
        await api("POST", f'/next-shop/choose/{item["catalog_id"]}', json={"catalog_id": chosen["catalog_id"]})
        return f'Picked {chosen["name"]} for {item["name"]}.'

    @server.tool(annotations=READ)
    async def before_you_order() -> dict:
        """What might be missing from the next shop: pick-one sets not picked, maybes not decided, regulars (on at
        least half of the last 12 shops) that aren't on it, and things due before the shop after. Ask the person
        about these before filling a basket."""
        plan = await api("GET", "/next-shop")
        forgotten = await api("GET", "/next-shop/forgotten")
        return {
            "pick_one_not_picked": [line(i) for i in plan["items"] if i["kind"] == "or" and i["chosen"] is None],
            "maybe": [line(i) for i in plan["maybe"]],
            "regulars_not_on_it": [{"name": r["name"], "qty": r["qty"], "why": r["reason"]} for r in forgotten["regulars"]],
            "due_before_the_shop_after": [{"name": r["name"], "qty": r["qty"], "why": r["reason"]} for r in forgotten["due_soon"]],
        }

    @server.tool(annotations=READ)
    async def find_items(query: str = "") -> list[dict]:
        """Common items whose name (or barcode) contains the query, most bought first; all of them if it's empty.
        Each has its aisle, how many shopping trips it was on, calories and macros per pack where known, and saved
        store products."""
        q = query.strip().lower()
        items = [c for c in await api("GET", "/catalog") if c["kind"] != "or" and (q in c["name"].lower() or (q and q in c["barcode"]))]
        items.sort(key=lambda c: (-c["trips"], c["name"].lower()))
        return [
            {"name": c["name"], "aisle": c["category"], "trips": c["trips"], "barcode": c["barcode"] or None,
             "never_swap": c["exact"], "kcal": c["kcal"], "protein_g": c["protein"], "carbs_g": c["carbs"], "fat_g": c["fat"],
             "products": {s: p["url"] for s, p in c["products"].items()}}
            for c in items[:100]
        ]

    @server.tool(annotations=READ)
    async def item_history(name: str) -> dict:
        """How often a common item is bought, when it's next expected, what it costs now and has cost, what's been
        spent on it, and its last few purchases."""
        catalog = [c for c in await api("GET", "/catalog") if c["kind"] != "or"]
        item = _named(catalog, name)
        if not item:
            raise ToolError(f"{name} isn't one of the common items")
        h = await api("GET", f'/history/items/{item["id"]}')
        return {
            "name": item["name"],
            "summary": h["summary"],
            "spent_eur": h["spend"],
            "kinds": [{"name": k["name"], "trips": k["trips"], "last_bought": k["last_bought"]} for k in h["by_kind"]],
            "last_purchases": [{"on": p["bought_on"], "qty": p["qty"], "each_eur": p["unit_price"], "as": p["bought_as"]}
                               for p in h["purchases"][-10:]],
        }

    @server.tool(annotations=READ)
    async def spending() -> dict | None:
        """What's been spent: the total, a shop and a week (over weeks with shopping), month by month (the last 12),
        and how prices of things bought again and again have moved."""
        s = await api("GET", "/spending")
        if s:
            s["months"] = s["months"][-12:]
        return s

    @server.tool(annotations=READ)
    async def basket_list(store: str = "tesco") -> dict:
        """The next shop as a basket to fill at "tesco" or "dunnes": each item with its quantity, the saved product
        page to use (when there is one) and whether it must never be swapped. Use these names in
        record_basket_results."""
        links = await api("GET", "/links")
        info = next((s for s in links["stores"] if s["id"] == store), None)
        if not info:
            raise ToolError('The store is "tesco" or "dunnes"')
        plan = await api("GET", "/next-shop")
        catalog = {c["id"]: c for c in await api("GET", "/catalog")}
        by_name = {c["name"].lower(): c for c in catalog.values()}
        lines = []
        for i in plan["items"]:
            picked = next((o for o in i["options"] or [] if o["catalog_id"] == i["chosen"]), None)
            c = catalog.get(picked["catalog_id"] if picked else i["catalog_id"] or -1) or by_name.get(i["name"].lower())
            entry = {"name": picked["name"] if picked else i["name"], "qty": i["qty"], "aisle": i["category"]}
            if i["kind"] == "or" and not picked:
                entry["one_of"] = [o["name"] for o in i["options"] or []]
            elif c:
                entry["product_url"] = (c["products"].get(store) or {}).get("url")
                entry["never_swap"] = c["exact"]
            lines.append(entry)
        return {"store": info["name"], "site": info["home"], "search": info["search"], "items": lines,
                "rules": "Only add to the basket. Never check out, pay, book or change a slot, or change the account."}

    @server.tool(annotations=WRITE)
    async def record_basket_results(store: str, results: list[BasketResult], total: str = "") -> dict:
        """After filling a basket: record what happened to every item, so the app shows what's missing, swapped or
        not mentioned before the person checks out. Products added for items with none saved become their saved
        product. store is "tesco" or "dunnes"."""
        text = json.dumps({"results": [r.model_dump() for r in results], "total": total})
        check = await api("POST", f"/basket/{store}/check", json={"text": text})
        return {
            "counts": check["counts"],
            "missing": [i["item"] for i in check["items"] if i["status"] == "missing"],
            "swapped": [f'{i["item"]} → {i["product"]}' for i in check["items"] if i["status"] == "swapped"],
            "not_mentioned": check["unreported"],
            "total": check["total"],
        }

    @server.tool(annotations=WRITE)
    async def record_shop(store: str, date: str, items: list[RecordedLine]) -> dict:
        """Record a shop that's been done (in a store or delivered), so the history and the next shop move on:
        where (e.g. "Tesco", "Dunnes", "Lidl"), when (YYYY-MM-DD, not in the future) and what was bought.
        Bought things also come off the list."""
        return await api("POST", "/history/manual", json={"store": store, "date": date, "items": [i.model_dump() for i in items]})

    @server.tool(annotations=READ)
    async def last_basket_check(store: str = "tesco") -> dict | None:
        """The last recorded basket check for a store: what went in, what was swapped and what's missing."""
        return await api("GET", f"/basket/{store}/check")

    mcp_app = server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        # Reached over the home network by hostname or IP; MCP_TOKEN is the guard, as for the rest of the app.
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        host="0.0.0.0",
    )
    handler = next(r for r in mcp_app.routes if getattr(r, "path", None) == "/mcp").endpoint

    class Guarded:
        """The MCP endpoint, behind MCP_TOKEN when one is set. (A class, so Starlette passes it the raw request.)"""

        async def __call__(self, scope, receive, send):
            if token:
                headers = dict(scope.get("headers") or [])
                sent = headers.get(b"authorization", b"").decode()
                query = dict(p.split("=", 1) for p in scope.get("query_string", b"").decode().split("&") if "=" in p)
                given = sent.removeprefix("Bearer ").strip() if sent.startswith("Bearer ") else query.get("token", "")
                if not hmac.compare_digest(given.encode(), token.encode()):
                    await JSONResponse({"error": "This needs the MCP token."}, status_code=401)(scope, receive, send)
                    return
            await handler(scope, receive, send)

    route = Route("/mcp", endpoint=Guarded(), methods=["GET", "POST", "DELETE"])
    return route, lambda: mcp_app.router.lifespan_context(mcp_app)
