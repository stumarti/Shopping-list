# Shopping list (web)

A shared shopping list in one Docker container: a React page served by a FastAPI backend, with the list kept in SQLite. It comes with a browser helper that fills your Tesco or Dunnes basket.

- **Next shop** (the first page): when you'll probably shop next (from your past trips: your usual gap between shops and the day you usually go) and what you'll need, aisle by aisle. Each item has a badge: **Weekly**, **Every 2 weeks** (or however often it runs) for steady habits, **Not sure** for things you buy unevenly or now and then, and **Added** for what you've added yourself. Tap × to take something off this shop (it's back for the next one; **Undo** and **Put back** are there if you change your mind). An item is on when it's expected before about halfway to the shop after, so it won't run out in between. **Not sure** items wait under **Maybe** until you add them. Tap an aisle (in Your typical shop, or an aisle heading) to see just that aisle: what you'll need, what you added, the maybes and everything else you buy there, each with **+ Add**.
- **Most bought first**: Next shop and Common items list the things you buy most often first. **By aisle** (top right of each) switches to aisle order; each device remembers its choice.
- **Kinds of one thing**: open an item in Common items and set **Kind of** (e.g. *Broccoli* for tenderstem and florets). The kinds sit under one generic item, their purchases count together, and the next shop asks for *Broccoli* once instead of each kind every other week. Take a kind out again from its generic item.
- **Pick one**: set **Pick one of** (e.g. *Protein*) on things where one will do in a week, such as chicken, mince or salmon. When any of them is due, the next shop shows one line with the options (a dot marks the ones due); tap the one you'll get.
- **Calories and macros**: set calories, protein, carbs and fat **per pack** on common items and the next shop adds them up against a week for your household: adults (about 2,250 kcal a day) and children (about 1,600) entered separately, with macros against the reference intakes scaled to that. It also shows **a usual week** from your history, counting only weeks you shopped. A generic item without its own figures uses the average of its kinds; a pick-one set not yet picked shows the range. The household, macros and a **food pyramid** (how many things on this shop sit on each shelf; each item's food group is guessed from its name and aisle, and you can change it) are collapsed until you open them.
- **Your typical shop** (beside the next shop): products and spend per shop in each aisle, averaged over your trips in the last year.
- **Light or dark**: the switch at the top right goes Auto (follows the device), Light, Dark.
- **On your phone in the shop**: the pages move to a bar along the bottom, and the aisle chips above the list stay at the top as you scroll (each shows how much is left in that aisle). Tap the circle beside an item when it's in the trolley: it drops to **In the trolley** at the bottom, and a bar shows how far through you are. Ticks are kept on that phone for this shop's date, and start fresh for the next shop.
- **Icons** are [Material Symbols](https://fonts.google.com/icons) (rounded), bundled in the page so it works without the internet.
- **No starter items**: your common items come from what you upload, import or add.
- **Common items**, aisle by aisle. Tap one to see the weeks you bought it (a square per week, four to a column so habits line up, shaded by month, filled when you bought it, hollow when you didn't shop at all that week; it opens on the latest weeks, scroll back for older ones), its price over time, what you've spent on it, when it's expected next and every purchase; and to rename it, move it, set its barcode, calories, macros and food group, or delete it.
- **Spending and prices** (top of Common items): what you've spent, a shop and a week (weeks you didn't shop don't count), month by month, and how prices of the things you buy again and again have moved, with what's gone up and down most.
- **Settings** (top right): upload your Tesco data, **Find barcodes** for your items in Open Food Facts, set up your **aisles** (rename, reorder, add, remove), add common items in bulk, and **Start again**: remove all common items, then **Rebuild from history** (every product from an online order, and anything bought on two or more trips). **Clear all** is also at the top of Common items. Clearing never touches your list, purchase history or uploaded files.
- **Type anything** that isn't there, pick its aisle, and it's added to your list and remembered as a common item.
- Tick things off as you shop, change quantities, then **Clear ticked**.
- **Barcodes**: type or paste a barcode (8 to 14 digits) and tap **Look up**. It's found in [Open Food Facts](https://world.openfoodfacts.org) (then Open Beauty, Products and Pet Food Facts), and remembered with the item.
- **Check the shops**: every item links to its search results on [Tesco](https://www.tesco.ie/shop/en-IE/search?query=milk) and [Dunnes](https://www.dunnesstoresgrocery.com/results?q=milk), and to its barcode page on Open Food Facts.
- **Common items** tab: build your own list of usual items. Paste many at once (one per line), rename them, move them between aisles, add barcodes, or delete the ones you never buy.
- **Shop online** tab: your next shop on the left; tap an item to look it up on the store's site, **Save link** to paste its product address so it's exact next time, and tick **Never swap** on anything you want exactly as it is. On the right, a prompt to copy into **Claude in Chrome** on your signed-in store tab, which fills your basket and stops there (it's told never to check out, pay or touch your slot). Tick **Look for cheaper options** to have it compare like-for-like products by unit price (€/kg, €/L): **Suggest only** adds your usual items and lists what's cheaper, **Swap automatically** adds the cheaper one and tells you what it swapped, and either way it only counts savings above the % and cents you set. Never swap items are left alone, even when out of stock. The browser helper (below) still works too.
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

Tesco will send you everything you've bought with your Clubcard, in store and online: on tesco.ie, **My account → Request your Tesco data**. When the email arrives, download the file and, in **Settings**, press **Upload Tesco data file** (the `.json`, or the `.zip` as it came).

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

### Find barcodes

**Settings → Find barcodes** searches Open Food Facts (then Open Beauty and Open Products Facts) for each common item that has no barcode, by name, and assigns one only when the product clearly matches: nearly all of the item's words are in the product's brand, name and size, and the product doesn't add much else (Irish products win a tie). One-word names are skipped. Open Food Facts allows about 10 searches a minute, so it runs in the background on the server with a progress bar; you can leave the page. Each match can be undone (**Not this**), and an item you've set or cleared yourself is never changed.

### Aisles

**Settings → Aisles**: rename, reorder (↑ ↓), add and remove aisles. Renaming or removing one moves its items too (you pick where). *Other* is where unsorted things go, so it can be renamed but not removed. Aisles guessed for imported products follow your renames.

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
    finder.py          finds barcodes for items by name in Open Food Facts
    stats.py           how often each item is bought and what it costs
  frontend/src/
    App.tsx            the page and the My list tab
    ShopOnline.tsx     the Shop online tab: your list and the Claude in Chrome prompt, with cheaper options
    Shop.tsx           the older basket-helper page (not shown for now)
    NextShop.tsx       the Next shop tab: the list, maybes, aisles, calories, macros, food pyramid, typical shop
    Spending.tsx       spending and price changes, on Common items
    PriceChart.tsx     an item's price over time
    Theme.tsx          the light / dark switch
    Icon.tsx           Material Symbols icons, bundled from @material-symbols/svg-400
    History.tsx        Past shopping: uploads, what you buy, how often, prices
    Manage.tsx         the Common items tab: items (most bought first or by aisle), kinds, sets, each item's history
    Order.tsx          the Most bought / By aisle switch
    WeeklyChart.tsx    the weeks-bought grid
    Settings.tsx       upload, find barcodes, aisles, add items
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
| PATCH | `/api/catalog/{id}` | Change `{name, category, barcode, kcal, protein, carbs, fat, food_group, exact}` (`exact`: never swap it); `group` puts it under a generic item by name (`""` takes it out), `or_set` puts it in a pick-one set |
| DELETE | `/api/catalog/{id}` | Forget a common item |
| POST | `/api/catalog/clear` | Remove all common items (the list and history stay) |
| POST | `/api/catalog/rebuild` | Make common items again from the purchase history |
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
| GET | `/api/next-shop` | The next shop's likely date and reason, what it needs (with badges), the maybes, and what you took off |
| POST / DELETE | `/api/next-shop/skip/{catalog_id}` | Take an item off the next shop / put it back |
| POST | `/api/next-shop/choose/{set_id}` | Pick one option of a pick-one set for the next shop `{catalog_id}` (`null` to unpick) |
| GET | `/api/typical-shop` | A typical shop over the last year: products, spend and calories per shop, aisle by aisle, and calories a week over weeks you shopped |
| GET | `/api/spending` | Total spend, a shop, a week, month by month, and price changes of things you buy again and again |
| GET | `/api/food-groups` | The food pyramid's shelves, bottom first |
| GET | `/api/history` | Imported trips, newest first, and the items bought most often: trips, about how often, usual quantity, prices |
| GET | `/api/history/items/{id}` | Every purchase of one common item: when, quantity, price each, where |
| GET | `/api/aisles` | Aisles in order, with how many items each has |
| POST / PATCH / DELETE | `/api/aisles`, `/api/aisles/{id}` | Add `{name}`, rename `{name}`, remove (`?move_to={id}`) |
| PUT | `/api/aisles/order` | `{ids}` in the new order |
| POST / GET | `/api/barcodes/find` | Start finding barcodes (`{retry}`) / progress and matches |
| POST | `/api/barcodes/find/stop` | Stop |
| GET | `/api/barcode/{code}` | Look a barcode up (your items first, then Open Food Facts) |
| GET | `/api/links` | The Tesco, Dunnes and barcode directory link addresses |
| GET | `/userscript/shopping-list.user.js` | The browser helper, pointed back at this server |

Interactive API docs are at <http://localhost:8080/docs>.

`catalog.py` holds the starter aisles and the words used to guess a product's aisle.

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
