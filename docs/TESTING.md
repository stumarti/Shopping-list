# Testing on your own devices

Automated tests cover the server, the worker and the app's sync logic, and CI runs them on every push.
What they can't cover is the real hardware and real websites. Work through this list once with the server
at home, your iPhone, your partner's iPhone and the iPad. When something's off, open **Sharing & sync →
Share diagnostics** and paste the result into the bug report along with what you did.

Tick each box as you go. ⚠️ marks the things most likely to need a fix.

## 1. Server

- [ ] `cp .env.example .env`, fill in `APP_TOKEN` and `ANTHROPIC_API_KEY`, run `docker compose up -d --build`
- [ ] `curl http://localhost:8787/api/health` shows `"ok":true` and `"ai":{"backend":"claude",…}`
- [ ] `docker compose logs server` has no errors
- [ ] ⚠️ From your phone's browser on home Wi-Fi, `http://<server-ip>:8787/api/health` loads (checks the firewall)
- [ ] Optional: `tailscale serve --bg 8787`, then `https://<server>.<tailnet>.ts.net/api/health` loads on mobile data

## 2. First sign-in (your iPhone, Expo Go)

- [ ] `cd apps/mobile && npm install && npx expo start`, scan the QR code, and the app opens on the welcome screen
- [ ] Name, server address and setup token, then **Connect**: you land on the list
- [ ] Close Expo Go completely and reopen: still signed in (the token is in the Keychain)
- [ ] **Sharing & sync** shows your name and *Connected*; Server features shows Claude and the version

## 3. Adding items

- [ ] Type `2 L milk, bread, 6 eggs`: three items appear in the right aisles
- [ ] ⚠️ **Scan barcode**: the camera permission prompt appears, then scanning a packet finds it (try milk, cereal, a tin)
- [ ] ⚠️ Scan something **own-brand** (Tesco or Dunnes): you should get "Not in the product database" → **Identify from a photo**
- [ ] ⚠️ **Photo** of a product: within a few seconds you get the name, brand and size. Edit something and add it
- [ ] Scan that same own-brand barcode again: it's now recognised straight away ("remember this barcode")
- [ ] Turn on the torch in the scanner in a dim room
- [ ] Long-press an item: edit its name, quantity and aisle; delete one

## 4. Sharing with your partner

- [ ] **Invite someone** → the share sheet opens → send it by iMessage
- [ ] ⚠️ On their iPhone (Expo Go installed), tapping the link opens the app on *Join the list*. If it doesn't open the app, note what happens
- [ ] They enter their name and **Join**: they see your items, with your initial on each
- [ ] They add an item: it appears on your phone within about 15 seconds, with their initial
- [ ] Both of you tick different items at the same time: both end up ticked on both phones
- [ ] **Add another device for me** → open the link on the iPad: it signs in as you (no name asked)

## 5. Offline

- [ ] Airplane mode: add and tick items. The status line says *Offline · N changes waiting*
- [ ] Airplane mode off: within 15 seconds it says *Synced*, and the other phone has the changes

## 6. Lists, aisles and trips

- [ ] Tap the list name → create a **private** list. Your partner doesn't see it
- [ ] Reorder aisles: your partner's list follows the new order
- [ ] **Start shopping**: your partner sees "<you> is shopping now"
- [ ] Tick a few items, then **Finish**: you're offered *Clear ticked*. The trip appears in **Past trips**
- [ ] After two or three trips a week or so apart, **Usual items** chips start appearing

## 7. Price checks (optional)

- [ ] Uncomment `WORKER_URL` and `WORKER_TOKEN` in `.env`, run `docker compose --profile prices up -d --build`
- [ ] Server features shows *Price checks: On*
- [ ] ⚠️ The tag icon on the list → **Check prices**: the progress bar moves, and results appear per store
- [ ] ⚠️ Open each store: do the matched products and prices look right compared with the websites?
- [ ] If every item says *Couldn't load the store page*, run `docker compose logs worker` and send the errors.
      Stores may block automated browsers; if so, say which store
- [ ] Set `DUNNES_SEARCH_URL` to your own branch's search URL (see `.env.example`) and check again

## 8. Online ordering (once the store adapters are finished)

- [ ] **Shop online** → *Link Tesco account* → sign in through the live view. Tap fields, type in the box underneath, then **Done**
- [ ] ⚠️ Without a booked slot, the store card says to book one in the store's app
- [ ] Book a slot in the Tesco app → *Check again*: the slot shows
- [ ] **Fill my Tesco basket**: exact matches are found, and items without one ask you to choose
- [ ] Choose, skip and search again on a few items, change a quantity, then **Add to basket**
- [ ] ⚠️ Open the Tesco app: the basket has exactly those products and quantities
- [ ] Your partner links their own account; their order goes to their basket, not yours

## 9. Local AI (optional)

- [ ] Install [Ollama](https://ollama.com) on the PC or Mac mini and pull a vision model
- [ ] Set `OLLAMA_URL`, `OLLAMA_MODEL` and `AI_BACKEND=ollama` (or `ollama-then-claude`), then restart the server
- [ ] Server features shows the Ollama model. Photograph the same five products you used with Claude and compare the results
