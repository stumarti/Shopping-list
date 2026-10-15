# Press

A shared grocery list for two iPhones (and an iPad), synced through a small server on your home network. (*The press* is what we call the kitchen cupboard in Ireland.)

> Just want a simple shared list in your browser? [`web/`](web/README.md) is a separate React + FastAPI version in one Docker container: `cd web && docker compose up -d --build`, then open port 8080.

- **Add items** by scanning a barcode, taking a photo (Claude identifies the type, brand and size), or typing ("2 L milk, bread, 6 eggs").
- **Grouped by aisle** in a typical supermarket order, which you can rearrange to match your shop.
- **Shared**: everyone on the server sees the main list. Changes made offline are queued and sent when the server is reachable.
- **Per person**: each person (and each of their devices) has their own login, so items show who added them and a lost phone can be signed out on its own. You can also make **private lists** only you can see.
- **Shopping trips**: tap *Start shopping* in the shop; your partner sees "Alex is shopping now", and whatever you tick is saved to *Past trips*. That history powers **usual items** ("Free-range eggs · 7d ago") so regulars are one tap to re-add.

```
apps/mobile   Expo (React Native) app for iPhone/iPad
server        Node + SQLite API: sync, barcode lookup (Open Food / Beauty / Products / Pet Food Facts), AI (Claude and/or a local model), price checks
worker        Optional: Playwright browser for price checks and for filling your Tesco/Dunnes basket
```

Once it's running, work through [docs/TESTING.md](docs/TESTING.md) on your phones.

## 1. Run the server (home server, Docker)

You need a machine that stays on at home (a PC, Mac mini, NAS or Raspberry Pi 4/5) with Docker and Docker Compose v2.
On Windows or a Mac, install [Docker Desktop](https://www.docker.com/products/docker-desktop/). On Linux, install Docker Engine and the `docker-compose-plugin` package.

### Quick start

```sh
git clone https://github.com/stumarti/Shopping-list.git shopping-list
cd shopping-list
cp .env.example .env              # then fill in APP_TOKEN and ANTHROPIC_API_KEY (see below)
docker compose up -d --build
curl http://localhost:8787/api/health
# {"ok":true,"version":"0.3.0","ai":{"backend":"claude",...},"priceCheck":false,...}
```

- `APP_TOKEN`: a long random **setup** secret, used once by the first person to connect. Everyone else joins with an invite link from the app, so nobody else needs it. Generate one with `openssl rand -hex 24`.
- `ANTHROPIC_API_KEY`: from [console.anthropic.com](https://console.anthropic.com). This is the pay-as-you-go API, separate from a Claude.ai subscription. A photo costs about a cent. Without a key, everything works except photo identification, and typed lists are split with simple rules instead.
- Data lives in the `shopping-data` Docker volume (`/data/shopping.db`).

### The Compose file

This is `docker-compose.yml` from the repo. You don't need to change it; everything you set goes in `.env`.

```yaml
services:
  server:
    build: ./server
    restart: unless-stopped
    ports:
      - "8787:8787"
    env_file: .env
    # Lets the server reach Ollama running on the same machine (host.docker.internal) on Linux too.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - shopping-data:/data
      # Drop old receipts (photos or PDFs) in here to import them; see README.
      - ./receipts-inbox:/receipts-inbox

  # Optional: read-only Tesco/Dunnes price checks. Start with: docker compose --profile prices up -d
  worker:
    build: ./worker
    profiles: ["prices"]
    restart: unless-stopped
    env_file: .env
    # Not published: only the server talks to it, over the private Compose network.
    expose:
      - "8788"
    shm_size: "1gb"
    volumes:
      - worker-data:/data

volumes:
  shopping-data:
  worker-data:
```

| Part | What it does |
|---|---|
| `server` | The API the phones talk to, on port **8787**. Holds the lists, people, history and receipts in SQLite. |
| `worker` | A headless Chromium that reads Tesco/Dunnes prices and fills baskets. Only starts with `--profile prices`. It has no published port, so only the server can reach it (at `http://worker:8788`). `shm_size` stops Chromium crashing on big pages. |
| `shopping-data` | The database (`/data/shopping.db`). **This is the one to back up.** |
| `worker-data` | The worker's browser profiles, i.e. your signed-in store sessions. Store passwords are never saved. |
| `./receipts-inbox` | A folder next to the Compose file. Copy old receipts into it and they're imported (see *Receipts* below). |
| `extra_hosts` | Makes `host.docker.internal` point at the home server itself, so the server can use Ollama running outside Docker. |

To use a different port on the host, change the left side only, e.g. `"8080:8787"`.

### Your `.env`

Only the first two are required. The rest are explained in the optional sections below.

```sh
APP_TOKEN=<openssl rand -hex 24>
ANTHROPIC_API_KEY=sk-ant-...

# Local AI instead of (or before) Claude
# OLLAMA_URL=http://host.docker.internal:11434
# OLLAMA_MODEL=...
# AI_BACKEND=ollama-then-claude          # claude | ollama | ollama-then-claude | none

# Price checks and online baskets (needs --profile prices)
# WORKER_URL=http://worker:8788
# WORKER_TOKEN=<openssl rand -hex 24>    # shared by server and worker

# Bulk receipt import
RECEIPTS_INBOX=/receipts-inbox
```

After changing `.env`, run `docker compose up -d` again so the containers pick it up.

### Everyday commands

```sh
docker compose up -d --build                    # start (or rebuild after an update)
docker compose --profile prices up -d --build   # start with the price/basket worker too
docker compose ps                               # what's running
docker compose logs -f server                   # follow the server log (Ctrl+C to stop)
docker compose logs -f worker
docker compose restart server
docker compose --profile prices down            # stop everything (your data stays in the volumes)
```

To update to the latest version:

```sh
git pull
docker compose --profile prices up -d --build   # leave out --profile prices if you don't use it
```

Database changes are applied automatically when the server starts.

### Backups

Everything you'd miss is in the `shopping-data` volume. Compose prefixes volume names with the folder name, so check yours with `docker volume ls` (it's usually `shopping-list_shopping-data`).

```sh
# Back up (writes shopping-backup.tgz to the current folder)
docker compose stop server
docker run --rm -v shopping-list_shopping-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/shopping-backup.tgz -C /data .
docker compose start server

# Restore
docker compose stop server
docker run --rm -v shopping-list_shopping-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/shopping-backup.tgz -C /data"
docker compose start server
```

On Windows PowerShell, use `${PWD}` in place of `"$PWD"`. Stopping the server for a few seconds makes sure the copy is consistent.

### Reaching it from your phones

On home Wi-Fi, `http://<server-ip>:8787` works. To also sync and use photo identification **away from home** without opening ports, use [Tailscale](https://tailscale.com):

1. Install Tailscale on the server and both phones, all signed into the same account (or share the server with your partner's account).
2. On the server, run `tailscale serve --bg 8787`. This gives you `https://<server-name>.<tailnet>.ts.net` with a real HTTPS certificate.
3. Use that address in the app.

### Optional: a local AI model (Ollama)

Run [Ollama](https://ollama.com) on the Windows PC or a Mac mini, pull a vision-capable model, then set these in `.env` and restart:

```sh
OLLAMA_URL=http://host.docker.internal:11434   # or http://<pc-ip>:11434 if Ollama is on another machine
OLLAMA_MODEL=<the model you pulled>
AI_BACKEND=ollama-then-claude                   # or "ollama" to never use Claude
```

`ollama-then-claude` tries the local model first and asks Claude only when the local model fails or isn't sure what a photo shows, so most photos stay at home. **Sharing & sync → Server features** in the app shows which backend is answering. Expose Ollama on the network with `OLLAMA_HOST=0.0.0.0` if it runs on a different machine from Docker.

### Optional: price checks (Tesco / Dunnes)

The app's tag icon compares what your list would cost at Tesco and Dunnes. It is **read-only**: it searches each store's public website, never signs in, and never touches a basket.

```sh
# in .env: uncomment WORKER_URL and WORKER_TOKEN, and set DUNNES_SEARCH_URL to your branch
docker compose --profile prices up -d --build
```

How it works: the `worker` container runs a real Chromium (Playwright), opens each store's search page for an item and returns the page text. The server keeps only the lines around prices and asks the AI to pick the best-matching product and read its price (the Clubcard/member price when shown). Totals are compared on the items both stores have. Results are cached for 12 hours, and searches on each store are spaced a few seconds apart.

Things to know:
- **Cost**: each item at each store is one AI call over a few thousand characters of page text. Set `CLAUDE_PRICE_MODEL=claude-haiku-4-5` to use a cheaper model just for this, or use a local model.
- **Fragility**: stores change their sites and may block automated browsers. Because the AI reads the page text rather than relying on page layout, small redesigns shouldn't break it, but a block will. You'll see *Couldn't load the store page* and errors in `docker compose logs worker`.
- **Terms of use**: both stores' terms restrict automated access. This is light, personal, read-only use, but it's your call.

### Optional: fill your online basket (delivery or click & collect)

From the store icon on the list: **Shop online** → pick Tesco or Dunnes.

1. **Link your account once.** The app shows the server's browser on the store's sign-in page. You sign in yourself, including any code the store sends you. The server keeps that browser session for you; it never stores your password. Everyone links their own account.
2. **Book a slot in the store's app** as usual. The app reads your account and won't fill the basket until it sees a booked slot.
3. **Matching.** Each item still to buy is searched for. Exact matches (same product, brand and size) go straight in.
4. **Choose substitutes** for anything without an exact match, from the closest few, or search again or skip.
5. **Add to basket.** The server adds everything with quantities to your real basket and reports anything it couldn't add. You then **check out in the store's app**. This app never checks out or pays.

This uses the same worker as price checks (`docker compose --profile prices up -d`). **Status:** the whole flow is built and tested against a pretend store, but the Tesco and Dunnes parts are still to be written against the live sites. See [docs/STORE-AUTOMATION.md](docs/STORE-AUTOMATION.md). To try the flow with the pretend store, run `cd worker && npx tsx test/fixtures/test-store.ts` and set `TEST_STORE_URL=http://<that machine>:8099` for the worker (password `correct-horse`).

### Receipts, your weekly plan and seasonal trends

The app learns what you buy from **receipts** and from items you tick off, then works out **what you'll need this week**.

- **Add receipts in the app:** go to *This week* → *Receipts*. Photograph a receipt (several photos for a long one), pick photos you already took, or choose a PDF e-receipt. The AI reads every line (it handles abbreviations like "AVONMORE FRSH MLK 2L"). You check it, untick anything that isn't a product, and add it to your history. The same receipt is never counted twice.
- **Import a pile of old receipts:** copy photos or PDFs into the `receipts-inbox` folder next to `docker-compose.yml`. One file per receipt; a sub-folder of photos counts as one long receipt. The server reads them in the background and moves each to `done/`, `duplicate/` or `failed/` (with a note saying why). iPhone **HEIC** photos can't be read: set *Settings → Camera → Formats → Most Compatible*, or export as JPEG. Cost is roughly a few cents per receipt with Claude; set `CLAUDE_RECEIPT_MODEL` for a cheaper model.
- **This week:** each product's usual gap between purchases (ignoring the odd skipped week) and its usual quantity predict when it's due. With a year or more of history it also learns **seasons**: it suggests soup in October and sprouts in December, and stops suggesting strawberries in winter. Things you seem to have stopped buying drop out.
- **Keep my list topped up:** switch this on and the server adds the "very likely" items to the list as they come due (checked hourly). Remove one and it's skipped for a week.
- **Add & fill basket:** from *This week*, add the plan to your list and go straight to filling your Tesco/Dunnes basket.
- **Trends:** spend per month (from receipts), what's in season for you now, your seasonal favourites month by month, and what you buy most.

## 2. Put the app on your iPhone (from Windows)

You don't need a Mac or Expo Go. Expo builds a real copy of the app in its cloud and you install it on your phone from a link. You'll need:

- [Node.js LTS](https://nodejs.org) on your PC
- a free [Expo account](https://expo.dev/signup)
- the [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr). Apple only lets you install your own apps on an iPhone with this.

The app ID is `ie.stumarti.press` (`ios.bundleIdentifier` in `apps/mobile/app.json`). It's permanent once you've built with it, so change it now if you want a different one. Then:

```sh
cd apps/mobile
npm install
npx eas-cli@latest login
npx eas-cli@latest device:create      # once per phone/iPad: open the link it gives you on each device
```

Now pick how you want it.

### Just use it: a normal app, no PC needed afterwards

```sh
npx eas-cli@latest build --platform ios --profile preview
```

After 10 to 20 minutes you get a link and a QR code. Open it on each registered iPhone or iPad and tap **Install**. The app sits on your home screen like any other. To get changes later, run the same build again and reinstall.

### Work on it: your own app that reloads as you edit

```sh
npx eas-cli@latest build --platform ios --profile development   # once, and again only after adding a native package
npm start                                                        # each time you sit down to work
```

Install the development build from its link the same way. Open it, and it finds `npm start` on your PC (same Wi-Fi, or `npx expo start --dev-client --tunnel`). Edits on the PC appear on the phone straight away. It's your app with your icon and name, with a small developer menu (shake the phone) on top.

On iOS 16 and later, turn on **Settings → Privacy & Security → Developer Mode** the first time you open a build installed this way.

### Signing in

The first time the app opens, enter your name, the server address and the `APP_TOKEN`, then tap **Connect**. The server gives this device its own login, stored in the iPhone Keychain.

Then, in **Sharing & sync** (the people icon):
- **Invite someone** sends a link your partner opens on their phone to join as themselves. They need the app installed first, so register their phone with `device:create` before you build (or use TestFlight, below).
- **Add another device for me** sends a link to sign your iPad in as you.

Invite links work once and expire after 7 days.

## 3. TestFlight (no device registration)

Builds from section 2 only install on phones you registered. TestFlight avoids that, and is the easiest way to keep your partner's phone up to date: they get an update notification each time you build.

```sh
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios
```

In App Store Connect → TestFlight, add yourself and your partner as testers. They install Apple's TestFlight app and accept the invite.

## Development

GitHub Actions runs everything below on every push and pull request (`.github/workflows/ci.yml`), plus a Docker build of the server and worker.

```sh
cd server && npm install && npm test && npm run dev    # API on :8787; without APP_TOKEN anyone can create an account
cd worker && npm install && npm test
cd apps/mobile && npm test && npm run typecheck
```

### How sync works

Each change on a phone is applied immediately and queued as an operation (`item.upsert`, `item.delete`, `items.clearDone`, `sections.reorder`, `list.upsert`, `list.delete`). The app sends the queue to `POST /api/sync` when it's opened, after each change, and every 15 seconds while it's open. The server works out who sent it from the token, ignores ops on lists that person can't see, keeps the newest write for each item, and returns everything that person can see. A shopping list is small, so returning everything keeps it simple.

Ticking an item records a purchase (attached to your trip if one is running); unticking it again within a few hours undoes that. "Usual items" are things bought on at least two separate days whose usual gap has nearly passed since you last bought them.

### People and security

- Every device has its own random token; the server stores only a SHA-256 hash of it. Invite codes are stored the same way.
- `APP_TOKEN` can only create new people (`POST /api/setup`); it can't read or change the list.
- Anyone in the household can sign out another person's devices (for a lost phone). They then need a new invite.
- The aisle order is shared by everyone, since it describes the shop rather than a list.

### API

All `/api/*` routes except health, setup and join require `Authorization: Bearer <personal token>`.

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness, and whether Claude is configured |
| `POST /api/setup` | `{setupToken, name, device}` → new person + token (needs `APP_TOKEN`) |
| `POST /api/join` | `{code, name?, device}` → token, from an invite |
| `GET /api/me`, `PATCH /api/me` | Who you are, everyone on the server; rename yourself |
| `POST /api/invites` | `{forMe}` → one-time invite code (new person, or another device for you) |
| `POST /api/logout` | Sign this device out |
| `POST /api/people/:id/revoke` | Sign out all of a person's devices |
| `GET /api/state` | Lists, sections (in aisle order), items you can see, who's shopping |
| `POST /api/sync` | `{ops: [...]}` → applies them, returns state |
| `POST /api/trips`, `POST /api/trips/:id/finish` | Start / finish a shopping trip |
| `GET /api/lists/:id/history` | Past trips and what was bought |
| `GET /api/lists/:id/suggestions` | Usual items that are due and not on the list |
| `GET /api/online/stores`, `GET /api/online/:store/status` | Stores you can order from; is your account linked, and which slot is booked |
| `POST /api/online/:store/link`, `GET …/link/screenshot`, `POST …/link/input`, `POST …/link/done` | Live sign-in view for linking your store account |
| `POST /api/orders` | `{listId, store}` → checks the slot, then matches every item in the background |
| `GET /api/orders/:id`, `PATCH /api/orders/:id/lines/:itemId` | Review an order; `{choose}`, `{skip}`, `{qty}` or `{search}` per item |
| `POST /api/orders/:id/fill` | Add everything to your store basket |
| `GET /api/lists/:id/plan`, `POST …/plan/add`, `PUT …/plan/settings` | Weekly plan; add chosen items; switch automatic top-up on or off |
| `GET /api/lists/:id/trends` | Spend per month, seasonal items, most bought |
| `POST /api/lists/:id/receipts`, `GET …/receipts` | Read a receipt (photos or PDF) for review; list receipts |
| `GET/PATCH/DELETE /api/receipts/:id`, `POST /api/receipts/:id/confirm` | Review, correct, delete, or add a receipt to your history |
| `POST /api/lists/:id/price-check` | Start a read-only Tesco/Dunnes price check (runs in the background) |
| `GET /api/lists/:id/price-check`, `GET /api/price-checks/:id` | Latest / specific price check with progress and results |
| `GET /api/barcode/:code` | Local cache, then Open Food Facts |
| `PUT /api/barcode/:code` | Remember a product identified by photo |
| `POST /api/identify` | `{image: base64 JPEG}` → `{name, brand, size, sectionId, confidence}` via Claude |
| `POST /api/parse` | `{text}` → items with aisles (Claude for lists, simple rules for single items) |

The model defaults to `claude-opus-5-5` (override with `CLAUDE_MODEL`) at low effort. Requests opt into the API's server-side refusal fallback, so if the model declines an image, the API retries it on a fallback model.

## Roadmap

- Tesco and Dunnes adapters for online ordering (see docs/STORE-AUTOMATION.md)
- Push notifications when your partner adds items or starts shopping (the "who's shopping" data is already there; this needs Apple push setup)
