"""Barcode lookups in the Open Facts databases, and links to the stores' own search pages."""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

# Food first, then the sister databases for toiletries, household products and pet food.
OPEN_FACTS = [
    ("world.openfoodfacts.org", None),
    ("world.openbeautyfacts.org", "Toiletries"),
    ("world.openproductsfacts.org", "Household"),
    ("world.openpetfoodfacts.org", "Other"),
]

# Checked October 2026. {q} is replaced with the search term. Product pages look like
# tesco.ie/shop/en-IE/products/292769876 and dunnesstoresgrocery.com/product/<name>-id-100806897.
STORES = {
    "tesco": {
        "name": "Tesco",
        "host": "www.tesco.ie",
        "home": "https://www.tesco.ie/shop/en-IE/",
        "search": "https://www.tesco.ie/shop/en-IE/search?query={q}",
        "product": re.compile(r"^/(?:shop|groceries)/en-IE/products/(\d+)/?$"),
    },
    "dunnes": {
        "name": "Dunnes",
        "host": "www.dunnesstoresgrocery.com",
        "home": "https://www.dunnesstoresgrocery.com/",
        "search": "https://www.dunnesstoresgrocery.com/results?q={q}",
        "product": re.compile(r"^/product/[a-z0-9-]*?(\d{6,})/?$"),
    },
}
BARCODE_DIRECTORY = {
    "name": "Open Food Facts",
    "product": "https://world.openfoodfacts.org/product/{code}",
    # The ie. site lists products sold in Ireland.
    "search": "https://ie.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&search_terms={q}",
}

# Open Food Facts category tags → our aisles. First match wins, so specific tags come first.
CATEGORY_TAGS = [
    ("frozen", "Frozen"),
    ("breakfast-cereals", "Breakfast"),
    ("teas", "Breakfast"),
    ("coffees", "Breakfast"),
    ("eggs", "Dairy & eggs"),
    ("dairies", "Dairy & eggs"),
    ("cheeses", "Dairy & eggs"),
    ("yogurts", "Dairy & eggs"),
    ("butters", "Dairy & eggs"),
    ("milks", "Dairy & eggs"),
    ("breads", "Bakery"),
    ("pastries", "Bakery"),
    ("meats", "Meat & fish"),
    ("fishes", "Meat & fish"),
    ("seafood", "Meat & fish"),
    ("fruits", "Fruit & veg"),
    ("vegetables", "Fruit & veg"),
    ("snacks", "Snacks & treats"),
    ("chocolates", "Snacks & treats"),
    ("biscuits", "Snacks & treats"),
    ("crisps", "Snacks & treats"),
    ("beverages", "Drinks"),
    ("waters", "Drinks"),
    ("alcoholic", "Drinks"),
    ("pastas", "Cupboard"),
    ("rices", "Cupboard"),
    ("canned", "Cupboard"),
    ("sauces", "Cupboard"),
    ("spreads", "Cupboard"),
    ("condiments", "Cupboard"),
]

Fetch = Callable[[str], dict | None]


def is_barcode(text: str) -> bool:
    t = text.strip()
    return t.isdigit() and 8 <= len(t) <= 14


def category_from_tags(tags: list[str], fallback: str | None) -> str:
    for needle, aisle in CATEGORY_TAGS:
        if any(needle in tag for tag in tags):
            return aisle
    return fallback or "Other"


def http_fetch(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": "ShoppingList/1.0 (self-hosted)"})
    try:
        with urllib.request.urlopen(req, timeout=6) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def lookup_barcode(code: str, fetch: Fetch = http_fetch) -> dict | None:
    """Return {barcode, name, brand, quantity, category, source} or None if no database knows it.

    Raises OSError if none of the databases could be reached at all."""
    reached = False
    last_error: Exception | None = None
    fields = "product_name,product_name_en,generic_name,brands,quantity,categories_tags"
    for host, fallback in OPEN_FACTS:
        url = f"https://{host}/api/v2/product/{urllib.parse.quote(code)}.json?fields={fields}"
        try:
            data = fetch(url)
        except Exception as e:  # network trouble with one database shouldn't stop the others
            last_error = e
            continue
        reached = True
        product = (data or {}).get("product") if (data or {}).get("status") == 1 else None
        if not product:
            continue
        name = (product.get("product_name_en") or product.get("product_name") or product.get("generic_name") or "").strip()
        if not name:
            continue
        brand = (product.get("brands") or "").split(",")[0].strip()
        return {
            "barcode": code,
            "name": name,
            "brand": brand,
            "quantity": (product.get("quantity") or "").strip(),
            "category": category_from_tags(product.get("categories_tags") or [], fallback),
            "source": host.split(".")[1],
        }
    if not reached:
        raise OSError(f"Couldn't reach the barcode databases: {last_error}")
    return None


def fill_link(template: str, value: str) -> str:
    return template.replace("{q}", urllib.parse.quote(value.strip())).replace("{code}", urllib.parse.quote(value.strip()))


def link_templates() -> dict:
    stores = [
        {"id": sid, "name": s["name"], "home": s["home"],
         "search": os.environ.get(f"{sid.upper()}_SEARCH_URL") or s["search"]}
        for sid, s in STORES.items()
    ]
    return {"stores": stores, "barcodes": BARCODE_DIRECTORY}


def product_url(store: str, url: str) -> str:
    """Tidy a pasted product link down to the product page, or raise ValueError saying what's wrong."""
    info = STORES.get(store)
    if not info:
        raise ValueError("Unknown store")
    url = url.strip()
    if "://" not in url:
        url = "https://" + url
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or host.removeprefix("www.") != info["host"].removeprefix("www."):
        raise ValueError(f"That isn't a {info['name']} link. Open the product on {info['host']} and copy its address.")
    if not info["product"].match(parsed.path):
        raise ValueError(f"That's a {info['name']} page, but not a product. Open the product itself and copy its address.")
    return f"https://{info['host']}{parsed.path.rstrip('/')}"
