# Shopping list (web)

A shared shopping list in one Docker container: a React page served by a FastAPI backend, with the list kept in SQLite. It comes with a browser helper that fills your Tesco or Dunnes basket.

- Around 100 **common items**, grouped by aisle. Tap one to add it; tap again to add one more.
- **Type anything** that isn't there, pick its aisle, and it's added to your list and remembered as a common item.
- Tick things off as you shop, change quantities, then **Clear ticked**.
- **Barcodes**: type or paste a barcode (8 to 14 digits) and tap **Look up**. It's found in [Open Food Facts](https://world.openfoodfacts.org) (then Open Beauty, Products and Pet Food Facts), and remembered with the item.
- **Check the shops**: every item links to its search results on [Tesco](https://www.tesco.ie/shop/en-IE/search?query=milk) and [Dunnes](https://www.dunnesstoresgrocery.com/results?q=milk), and to its barcode page on Open Food Facts.
- **Common items** tab: build your own list of usual items. Paste many at once (one per line), rename them, move them between aisles, add barcodes, or delete the ones you never buy.
- **Shop online** tab: save the exact Tesco or Dunnes product for each item, then let the browser helper fill your basket (below).
- Anyone on your network who opens the page sees the same list. It refreshes every 10 seconds.

## Run it with Docker Compose

There are two ways: use the ready-made image (easiest, and the way to go on Unraid), or build it yourself from this folder.

### Ready-made image (Unraid or any server)

Every push to `main` and every `v*` tag builds an image, `ghcr.io/<github-user>/shopping-list-web`, and a Compose package (see [Releases](#releases) below). Download `shopping-list-unraid-<version>.zip` from the release (or from the workflow run's artifacts), unzip it and follow its README. In short, on **Unraid**:

1. **Apps** → install **Docker Compose Manager**.
2. **Docker** → **Compose** → **Add New Stack** called `shopping-list`.
3. **Edit Stack** → **Compose File**: paste the package's `docker-compose.yml`. **Env File**: paste its `.env`.
4. **Compose Up**, then open `http://<unraid-ip>:8080`.

The package's `docker-compose.yml` looks like this (from [`deploy/docker-compose.yml`](deploy/docker-compose.yml)):

```yaml
services:
  shopping-list:
    image: ghcr.io/<github-user>/shopping-list-web:latest
    container_name: shopping-list
    restart: unless-stopped
    ports:
      - "${PORT:-8080}:8080"
    environment:
      - PUID=${PUID:-99}            # owner of the data folder; 99:100 is Unraid's nobody:users
      - PGID=${PGID:-100}
      - TZ=${TZ:-Europe/Dublin}
      - PUBLIC_URL=${PUBLIC_URL:-}  # the address you open the list at, if a proxy changes it
      - TESCO_SEARCH_URL=${TESCO_SEARCH_URL:-}
      - DUNNES_SEARCH_URL=${DUNNES_SEARCH_URL:-}
    volumes:
      - ${DATA_DIR:-/mnt/user/appdata/shopping-list}:/data
```

On another Linux machine, set `DATA_DIR=./data` and `PUID`/`PGID` to your own (`id -u`, `id -g`) in `.env`, then `docker compose up -d`. Update with `docker compose pull && docker compose up -d`.

If the repository is private, the image is too: make the package public on GitHub (**Packages → shopping-list-web → Package settings → Change visibility**) or run `docker login ghcr.io` on the server once with a token that has `read:packages`.

### Build it yourself (Windows, Mac or Linux)

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
- Barcode lookups need the container to reach the internet.

### Either way

- The container starts as root only to hand `/data` to `PUID:PGID`, then runs the app as that user.
- There's no login. Keep it on your home network (or behind Tailscale) rather than opening it to the internet.
- If a store changes its search page, set `TESCO_SEARCH_URL` or `DUNNES_SEARCH_URL` with `{q}` where the search term goes.

## Filling an online basket

1. **Book your slot** in the Tesco or Dunnes app. The helper never books or changes one.
2. **Install the helper** once per computer. In Chrome or Edge, install [Tampermonkey](https://www.tampermonkey.net/), then open `http://<server>:8080/userscript/shopping-list.user.js` and press **Install**. When Tampermonkey asks whether the script may talk to your server, choose **Always allow**. On an iPhone or iPad, the free **Userscripts** app for Safari runs the same script.
3. **Save your products.** In **Shop online**, paste the product link for each item (open the product on the store's site and copy its address). Or browse the store with the helper installed: on any product page, its panel offers **Save this product for** an item on your list. You only do this once per item.
4. **Fill the basket.** On the store's site, press **Fill basket from my list** in the helper's panel (bottom right). It opens each saved product in turn, sets the quantity, presses **Add**, and ticks the item off your list. It waits a few seconds between products, like a person would.
5. **Check and pay yourself.** At the end it lists anything it couldn't add (out of stock, no saved product, or a page it didn't understand) with links to find a replacement. It never presses checkout, payment or slot buttons.

### Import your past orders

This saves every product you've bought, with its store product already linked, so filling the basket works for those items straight away.

1. On tesco.ie or dunnesstoresgrocery.com, open your order history and open an order.
2. Press **Import this order** in the helper's panel. It reads each product, its quantity and the order date, adds any new products to your common items (with a guessed aisle you can change) and records the order.
3. Go back and repeat for each order. Importing the same order twice does nothing.

**Shop online → Past orders** then shows how many orders you've imported and the items you buy most often, each with an **Add** button for your usual quantity.

### Import your Tesco Clubcard data

Tesco will send you everything you've bought with your Clubcard, in store and online: on tesco.ie, **My account → Request your Tesco data**. When the email arrives, download the file and, in **Shop online → Past shopping**, press **Upload Tesco data file** (the `.json`, or the `.zip` as it came).

- **Nothing is thrown away.** The file is kept exactly as uploaded in `imports/` next to the database (`/data/imports/` in Docker), and every trip and line is stored as exported (tables `clubcard_trips` and `clubcard_items`, with the original JSON), including totals, savings, payment and lines that aren't groceries.
- Every trip goes into your history with its exact time. Products bought on two or more trips become common items with a guessed aisle (`CLUBCARD_MIN_TRIPS` changes the two). Clothes (F&F), bags and gift cards are kept but left out of the figures.
- Upload a newer export any time: trips already imported are skipped.
- The export has no product links, so it can't fill a basket by itself. **Import this order** on a few recent online orders saves those.

**My list** then shows **From your past shopping**, in three groups:

- **You will want**: things you buy at a steady pace (at least every six weeks) that are due now, e.g. *About every week, last 7 days ago*. **Add all** puts them on the list in your usual quantities.
- **You might want**: steady items coming up soon, and items you buy regularly but unevenly that are about due.
- **Extras**: things you buy now and then (two or more times in the last year, not on a regular pace).

Items you've just bought, and ones you seem to have stopped buying, don't show. The thresholds are at the bottom of `backend/app/stats.py`.

**You often buy** (in Shop online) shows, for each item, how many trips it was on, roughly how often you buy it (and **due** when it's about time), and what it costs now compared with the first time, e.g. *€2.25 ▲ 6c since 4 Apr*. Tap an item for every purchase: when, how many, the price each and where.

### When a store changes its site

The helper updates itself from your server. When a store changes its site and the helper stops finding the **Add** button, the part to fix is the `STORES` section and the button patterns at the top of [`userscript/shopping-list.user.js`](userscript/shopping-list.user.js); bump its `@version` so Tampermonkey picks up the change.

To help fix it without sharing your account, press **Save page for Claude** in the helper's panel on the page that's not working. It downloads a copy of the page with scripts, form values, emails, phone numbers, Eircodes and any words you give it (your name, street) removed. Check it, then put it in [`userscript/fixtures/`](userscript/fixtures/README.md) or attach it to a Claude conversation.

Automated use may not be allowed by a store's terms. The helper only runs when you press the button, in your own browser and signed-in session, at a person's pace.

## Releases

[`.github/workflows/web-release.yml`](../.github/workflows/web-release.yml) builds and publishes everything:

| You do | You get |
|---|---|
| Push to `main` | Image `:latest` (amd64 and arm64), and the package as a downloadable artifact on the workflow run |
| Push a tag, e.g. `git tag v1.0.0 && git push origin v1.0.0` | Image `:1.0.0`, and a GitHub release with `shopping-list-unraid-1.0.0.zip` attached |
| **Actions → Web image and Unraid package → Run workflow** | The same for the branch you pick, tagged with the branch name |

Before publishing, it runs the API tests, builds the React app, runs the browser helper against a pretend store, and checks the image starts, serves the helper and hands its data folder to Unraid's user. To build the package by hand: `web/deploy/package.sh ghcr.io/<user>/shopping-list-web:latest dev <user>/<repo>`.

## How it's built

```
web/
  Dockerfile           node builds the React app, then a python:3.12-slim image runs uvicorn
  entrypoint.sh        gives /data to PUID:PGID, then drops to that user
  backend/app/
    main.py            FastAPI routes; also serves the React app and the browser helper
    db.py              SQLite tables and migrations, seeded with the common items
    catalog.py         the starter common items and aisle order
    lookup.py          barcode lookups, store link addresses and product-link checks
    clubcard.py        reads Tesco's Clubcard data export
    stats.py           how often each item is bought and what it costs
  frontend/src/
    App.tsx            the page and the My list tab
    Shop.tsx           the Shop online tab
    History.tsx        Past shopping: uploads, what you buy, how often, prices
    Manage.tsx         the Common items tab
    api.ts             calls to /api
  userscript/
    shopping-list.user.js   the browser helper (Tampermonkey / Userscripts)
    test/                   runs it in Chromium on a pretend tesco.ie
  deploy/              the Compose / Unraid package: compose file, .env, Unraid template, package.sh
```

| Method | Path | What it does |
|---|---|---|
| GET | `/api/catalog` | Common items in aisle order, with their saved store products |
| POST | `/api/catalog` | Add a common item `{name, category, barcode}` |
| POST | `/api/catalog/bulk` | Add many `{text, category}`, one per line; returns what was added and skipped |
| PATCH | `/api/catalog/{id}` | Change `{name, category, barcode}` |
| DELETE | `/api/catalog/{id}` | Forget a common item |
| PUT | `/api/catalog/{id}/products/{store}` | Save the product to buy at `tesco` or `dunnes`: `{url, title}` |
| DELETE | `/api/catalog/{id}/products/{store}` | Forget it |
| GET | `/api/list` | Your list, with saved store products |
| POST | `/api/list` | Add `{name, category, qty, barcode}`; adds to the quantity if it's already on the list |
| PATCH | `/api/list/{id}` | Change `{qty, done, note}` |
| DELETE | `/api/list/{id}` | Remove an item |
| POST | `/api/list/clear-done` | Remove ticked items |
| GET | `/api/basket/{store}` | What's still to buy, with the saved product or a search link for each |
| POST | `/api/basket/{store}/link` | Save a product for a list item `{item_id, url, title}` |
| POST | `/api/history/{store}/import` | Record a past order `{order_ref, date, items: [{name, qty, url}]}`; saves each product |
| POST | `/api/history/tesco/clubcard` | Upload Tesco's Clubcard data file (raw `.json` or `.zip` body) |
| GET | `/api/history` | Imported trips, newest first, and the items bought most often: trips, about how often, usual quantity, prices |
| GET | `/api/history/items/{id}` | Every purchase of one common item: when, quantity, price each, where |
| GET | `/api/barcode/{code}` | Look a barcode up (your items first, then Open Food Facts) |
| GET | `/api/links` | The Tesco, Dunnes and barcode directory link addresses |
| GET | `/userscript/shopping-list.user.js` | The browser helper, pointed back at this server |

Interactive API docs are at <http://localhost:8080/docs>.

`catalog.py` only seeds a new, empty database; after that, use the Common items tab.

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

# The browser helper's end-to-end test (needs the API's Python packages and Chromium)
cd web/userscript
npm install
npx playwright install chromium
PYTHON=../backend/.venv/bin/python npm test
```
