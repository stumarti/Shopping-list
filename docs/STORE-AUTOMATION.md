# Finishing Tesco and Dunnes online ordering

Everything except the store-specific code is built and tested:

- linking an account through the live sign-in view
- the slot check
- exact matching and choosing substitutes
- the review screen
- filling the basket

What's left is two files, `worker/src/stores/tesco.ts` and `worker/src/stores/dunnes.ts`. Each has to teach the worker how one real website works.

This work needs a machine that can reach tesco.ie and dunnesstoresgrocery.com, and a real account for each store. It was split out to be done in Claude Code on the Windows PC for that reason.

## How the pieces fit

```
App ──► server (/api/online/*, /api/orders/*) ──► worker (/account/*, /order/*) ──► StoreAdapter ──► store website
```

- **Matching** (`server/src/ordering.ts`) is store-independent: word matching first, then the AI, then substitutes. Adapters only return search results.
- **Browser profiles:** each person has their own, at `PROFILE_DIR/<userId>/<store>`. Signing in once through the live view (`worker/src/remote.ts`) stores the store's session cookies there. Every adapter method then gets a Playwright `Page` in that signed-in profile.
- **Pacing:** calls to a store are queued and spaced `STORE_GAP_MS` apart (`worker/src/limiter.ts`).

## The adapter contract (`worker/src/stores/types.ts`)

| Method | Must | Notes |
|---|---|---|
| `signInUrl` | Point to the store's sign-in page | Opened in the live view at phone size (390×720) |
| `basketUrl` | Point to the basket/trolley page | The app opens it for checkout. Prefer a URL that also opens the store's iOS app (universal link) |
| `isSignedIn(page)` | Return true only when the profile is signed in | Navigate to an account page and look for something that only appears when signed in |
| `getSlot(page)` | Return the booked slot `{ kind: "delivery" \| "collect", label }`, or `null` | Use the store's own wording for `label` (date and time window). Never book or change a slot |
| `search(page, query)` | Return the results as `Candidate[]` | `ref` must be enough for `addToBasket` to find exactly this product later: a product id or product-page URL, not a list position. Fill `size` and `available` (out of stock → false). `memberPrice` is the Clubcard / loyalty price if shown |
| `addToBasket(page, candidate, qty)` | Put `qty` of that exact product in the basket, or throw a short readable error | Make it idempotent where possible: if it's already in the basket, set the quantity rather than adding more. Confirm success from the page, not by assuming |

`worker/src/stores/test-store.ts` is a complete worked example against the pretend store in `worker/test/fixtures/test-store.ts`.

## Rules

- **Never** check out, pay, book or change a slot, change account details or accept terms. The flow ends at a filled basket.
- Prefer stable hooks in this order: accessible roles and labels (`getByRole`, `getByLabel`), then `data-*` test ids, then text. Avoid CSS class names: they change with every redesign.
- Before reaching for CSS selectors, check whether search results are also present as JSON in the page (embedded state or an XHR you can read with `page.waitForResponse`). That is usually more stable.
- Keep the polite pacing. Don't parallelise requests to one store.
- If the store shows a bot challenge, throw an error that says so. Don't try to get around it.
- Set `ordering: true` only once all four methods work against the live site.

## Developing it on the PC

```sh
# 1. Worker with a visible browser, so you can watch what it does
cd worker
npm install
npx playwright install chromium
HEADLESS=0 WORKER_TOKEN=dev npm run dev

# 2. Server pointing at it (another terminal)
cd server
npm install
APP_TOKEN=setup-secret WORKER_URL=http://localhost:8788 WORKER_TOKEN=dev npm run dev

# 3. Link your account once (from the app, or straight to the worker):
curl -X POST localhost:8788/account/open -H "authorization: Bearer dev" -H "content-type: application/json" \
     -d '{"owner":"me","store":"tesco"}'
#    then sign in in the visible browser window, and:
curl -X POST localhost:8788/account/close -H "authorization: Bearer dev" -H "content-type: application/json" \
     -d '{"owner":"me","store":"tesco"}'

# 4. Try each method
curl -X POST localhost:8788/order/slot   -H "authorization: Bearer dev" -H "content-type: application/json" -d '{"owner":"me","store":"tesco"}'
curl -X POST localhost:8788/order/search -H "authorization: Bearer dev" -H "content-type: application/json" -d '{"owner":"me","store":"tesco","query":"avonmore milk 2l"}'
```

`npx playwright codegen https://www.tesco.ie` records clicks into code and is handy for finding locators.

Worth adding: a small smoke test per store (e.g. `test/live-tesco.test.ts`) that only runs when `LIVE_STORE_TESTS=1` is set. CI must never sign in to a real account.

## Done when

- [ ] `isSignedIn` is false on a fresh profile and true after signing in through the live view
- [ ] `getSlot` returns the booked slot, and `null` when you cancel it
- [ ] `search("avonmore whole milk 2l")` returns sensible candidates with prices, sizes and stock
- [ ] `addToBasket` adds the right product and quantity, and a second call sets the quantity rather than doubling it
- [ ] An out-of-stock product fails with a readable error
- [ ] The full flow from the app on the iPhone fills a real basket, which you then check out in the store's app
- [ ] `ordering: true` is set, and the README is updated
