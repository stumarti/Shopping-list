# Press (shopping list)

A shared grocery list: an Expo iPhone app (`apps/mobile`), a self-hosted Node + SQLite server (`server`) and a Playwright worker (`worker`) that reads and fills Tesco/Dunnes online baskets. The README has the user-facing setup.

## Current work

Online ordering is built end to end against a pretend store. **What's left is the real store adapters**, `worker/src/stores/tesco.ts` and `dunnes.ts`. Read `docs/STORE-AUTOMATION.md` first: it has the adapter contract, the rules (never check out, pay or book slots) and how to develop against the live sites with a visible browser.

## Commands

```sh
cd server && npm test && npm run typecheck      # 64+ tests
cd worker && npm test && npm run typecheck      # real-browser tests run when Chromium is installed
cd apps/mobile && npm test && npm run typecheck
```

CI (`.github/workflows/ci.yml`) runs all of these plus an iOS bundle and both Docker builds.

## Conventions

- The app uses Expo SDK 57 and expo-router (`apps/mobile/src/app`). Read `apps/mobile/AGENTS.md` before touching Expo APIs, and install native packages with `npx expo install`.
- Server changes to the database go in a new entry in `MIGRATIONS` in `server/src/db.ts`. Never edit an existing migration.
- Sync is op-based with last-write-wins (`server/src/sync.ts`, mirrored in `apps/mobile/src/lib/ops.ts`). Keep the two in step.
- Purchase history (ticks + confirmed receipts, table `purchases`) drives the weekly plan (`server/src/forecast.ts`, pure and unit-tested; `planning.ts` wraps it with the database) and trends. Receipts: `server/src/receipts.ts`, bulk folder import `inbox.ts`.
- AI goes through the `Assistant` interface (`server/src/ai`). Prompts live in `prompts.ts`, shared by the Claude and Ollama backends.
- The server decides who a request is from (by token). Never trust a user id sent by the app. Orders and store sessions are per person.
- User-facing text is plain and friendly. Every action that touches a real store account stops at a filled basket.
