# Shopping list

A shared grocery list for two iPhones (and an iPad), synced through a small server on your home network.

- **Add items** by scanning a barcode, taking a photo (Claude identifies the type, brand and size), or typing ("2 L milk, bread, 6 eggs").
- **Grouped by aisle** in a typical supermarket order, which you can rearrange to match your shop.
- **Shared**: everyone on the server sees the main list. Changes made offline are queued and sent when the server is reachable.
- **Per person**: each person (and each of their devices) has their own login, so items show who added them and a lost phone can be signed out on its own. You can also make **private lists** only you can see.
- **Shopping trips**: tap *Start shopping* in the shop; your partner sees "Alex is shopping now", and whatever you tick is saved to *Past trips*. That history powers **usual items** ("Free-range eggs · 7d ago") so regulars are one tap to re-add.

```
apps/mobile   Expo (React Native) app for iPhone/iPad
server        Node + SQLite API: sync, barcode lookup (Open Food Facts), Claude proxy
```

## 1. Run the server (home server, Docker)

```sh
cp .env.example .env      # then fill in APP_TOKEN and ANTHROPIC_API_KEY
docker compose up -d --build
curl http://localhost:8787/api/health     # {"ok":true,"claude":true}
```

- `APP_TOKEN`: a long random **setup** secret, used once by the first person to connect. Everyone else joins with an invite link from the app, so nobody else needs it. Generate one with `openssl rand -hex 24`.
- `ANTHROPIC_API_KEY`: from [console.anthropic.com](https://console.anthropic.com). This is the pay-as-you-go API, separate from a Claude.ai subscription. A photo costs about a cent. Without a key, everything works except photo identification, and typed lists are split with simple rules instead.
- Data lives in the `shopping-data` Docker volume (`/data/shopping.db`).

### Reaching it from your phones

On home Wi-Fi, `http://<server-ip>:8787` works. To also sync and use photo identification **away from home** without opening ports, use [Tailscale](https://tailscale.com):

1. Install Tailscale on the server and both phones, all signed into the same account (or share the server with your partner's account).
2. On the server, run `tailscale serve --bg 8787`. This gives you `https://<server-name>.<tailnet>.ts.net` with a real HTTPS certificate.
3. Use that address in the app.

## 2. Run the app (from Windows)

You don't need a Mac. Install [Node.js LTS](https://nodejs.org) and put the **Expo Go** app on your iPhone.

```sh
cd apps/mobile
npm install
npx expo start
```

Scan the QR code with the iPhone camera, and the app opens in Expo Go. Edits on your PC reload on the phone instantly. The PC and phone need to be on the same Wi-Fi network (or run `npx expo start --tunnel`).

The first time the app opens, enter your name, the server address and the `APP_TOKEN`, then tap **Connect**. The server gives this device its own login, stored in the iPhone Keychain.

Then, in **Sharing & sync** (the people icon):
- **Invite someone** sends a link your partner opens on their phone to join as themselves.
- **Add another device for me** sends a link to sign your iPad in as you.

Invite links work once and expire after 7 days.

## 3. Install it properly (TestFlight)

Expo Go is for development. To install the app for real on both phones, you need the [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr):

1. In `apps/mobile/app.json`, change `ios.bundleIdentifier` from `com.example.shoppinglist` to something you own, e.g. `ie.yourname.shoppinglist`.
2. Build in Expo's cloud and send it to TestFlight:
   ```sh
   npx eas-cli@latest login
   npx eas-cli@latest build --platform ios --profile production
   npx eas-cli@latest submit --platform ios
   ```
3. In App Store Connect → TestFlight, add yourself and your partner as testers.

## Development

```sh
cd server && npm install && npm test && npm run dev    # API on :8787; without APP_TOKEN anyone can create an account
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
| `GET /api/barcode/:code` | Local cache, then Open Food Facts |
| `PUT /api/barcode/:code` | Remember a product identified by photo |
| `POST /api/identify` | `{image: base64 JPEG}` → `{name, brand, size, sectionId, confidence}` via Claude |
| `POST /api/parse` | `{text}` → items with aisles (Claude for lists, simple rules for single items) |

The model defaults to `claude-opus-5-5` (override with `CLAUDE_MODEL`) at low effort. Requests opt into the API's server-side refusal fallback, so if the model declines an image, the API retries it on a fallback model.

## Roadmap

- Price comparison between Tesco and Dunnes (read-only report)
- Filling a Tesco/Dunnes basket from the list (stops before checkout)
- Push notifications when your partner adds items or starts shopping (the "who's shopping" data is already there; this needs Apple push setup)
