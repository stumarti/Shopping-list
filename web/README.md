# Shopping list (web)

A simple shared shopping list in one Docker container: a React page served by a FastAPI backend, with the list kept in SQLite.

- Around 100 **common items**, grouped by aisle. Tap one to add it; tap again to add one more.
- **Type anything** that isn't there, pick its aisle, and it's added to your list and remembered as a common item.
- Tick things off as you shop, change quantities, then **Clear ticked**.
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
- There's no login. Keep it on your home network (or behind Tailscale) rather than opening it to the internet.

## How it's built

```
web/
  Dockerfile           node builds the React app, then a python:3.12-slim image runs uvicorn
  backend/app/
    main.py            FastAPI routes; also serves the built React app
    db.py              SQLite tables, seeded with the common items
    catalog.py         the common items and aisle order (edit this to change the starting list)
  frontend/src/
    App.tsx            the whole page
    api.ts             calls to /api
```

| Method | Path | What it does |
|---|---|---|
| GET | `/api/catalog` | Common items, in aisle order |
| POST | `/api/catalog` | Add a common item `{name, category}` |
| DELETE | `/api/catalog/{id}` | Forget a common item |
| GET | `/api/list` | Your list |
| POST | `/api/list` | Add `{name, category, qty}`; adds to the quantity if it's already on the list |
| PATCH | `/api/list/{id}` | Change `{qty, done, note}` |
| DELETE | `/api/list/{id}` | Remove an item |
| POST | `/api/list/clear-done` | Remove ticked items |

Interactive API docs are at <http://localhost:8080/docs>.

`catalog.py` only seeds a new, empty database. To start again from it, remove the volume: `docker compose down -v`.

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
