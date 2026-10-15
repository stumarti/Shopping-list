# Shopping list (web)

A simple shared shopping list in one Docker container: a React page served by a FastAPI backend, with the list kept in SQLite.

- Around 100 **common items**, grouped by aisle. Tap one to add it; tap again to add one more.
- **Type anything** that isn't there, pick its aisle, and it's added to your list and remembered as a common item.
- Tick things off as you shop, change quantities, then **Clear ticked**.
- **Barcodes**: type or paste a barcode (8 to 14 digits) and tap **Look up**. It's found in [Open Food Facts](https://world.openfoodfacts.org) (then Open Beauty, Products and Pet Food Facts), and remembered with the item.
- **Check the shops**: every item links to its search results on [Tesco](https://www.tesco.ie/shop/en-IE/search?query=milk) and [Dunnes](https://www.dunnesstoresgrocery.com/results?q=milk), and to its barcode page (or a search of Irish products) on Open Food Facts.
- **Common items** tab: build your own list of usual items. Paste many at once (one per line), rename them, move them between aisles, add barcodes, or delete the ones you never buy.
- Anyone on your network who opens the page sees the same list. It refreshes every 10 seconds.

## Run it

You need Docker (Docker Desktop on Windows or Mac).

```sh
cd web
docker compose up -d --build
```

Open <http://localhost:8080>, or `http://<your-pc's-ip>:8080` from a phone on the same Wi-Fi.

```yaml
# web/docker-compose.yml
services:
  shopping:
    build: .
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - shopping-web-data:/data

volumes:
  shopping-web-data:
```

- The list lives in the `shopping-web-data` volume (`/data/shopping.db`), so it survives restarts and rebuilds.
- To use another port, change the left side, e.g. `"3000:8080"`.
- Update after changing the code: `docker compose up -d --build`. Logs: `docker compose logs -f`.
- If a store changes its search address, set `TESCO_SEARCH_URL` or `DUNNES_SEARCH_URL` (with `{q}` where the search term goes) under `environment:` in the Compose file. Barcode lookups need the container to reach the internet.
- There's no login. Keep it on your home network (or behind Tailscale) rather than opening it to the internet.

## How it's built

```
web/
  Dockerfile           node builds the React app, then a python:3.12-slim image runs uvicorn
  backend/app/
    main.py            FastAPI routes; also serves the built React app
    db.py              SQLite tables, seeded with the common items
    catalog.py         the starter common items and aisle order
    lookup.py          barcode lookups and the store/barcode link addresses
  frontend/src/
    App.tsx            the whole page
    api.ts             calls to /api
```

| Method | Path | What it does |
|---|---|---|
| GET | `/api/catalog` | Common items, in aisle order |
| POST | `/api/catalog` | Add a common item `{name, category, barcode}` |
| POST | `/api/catalog/bulk` | Add many `{text, category}`, one per line; returns what was added and skipped |
| PATCH | `/api/catalog/{id}` | Change `{name, category, barcode}` |
| DELETE | `/api/catalog/{id}` | Forget a common item |
| GET | `/api/list` | Your list |
| POST | `/api/list` | Add `{name, category, qty, barcode}`; adds to the quantity if it's already on the list |
| PATCH | `/api/list/{id}` | Change `{qty, done, note}` |
| DELETE | `/api/list/{id}` | Remove an item |
| POST | `/api/list/clear-done` | Remove ticked items |
| GET | `/api/barcode/{code}` | Look a barcode up (your items first, then Open Food Facts) |
| GET | `/api/links` | The Tesco, Dunnes and barcode directory link addresses |

Interactive API docs are at <http://localhost:8080/docs>.

`catalog.py` only seeds a new, empty database; after that, use the Common items tab. To start again from it, remove the volume: `docker compose down -v`.

## Develop without Docker

```sh
# API on :8000
cd web/backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
pytest
uvicorn app.main:app --reload                      # the list is saved in shopping.db here

# React on :5173, calling the API above (another terminal)
cd web/frontend
npm install
npm run dev
```
