import { dunnes } from "./dunnes.js";
import { tesco } from "./tesco.js";
import { testStore } from "./test-store.js";
import type { StoreAdapter } from "./types.js";

export * from "./types.js";

export function storeAdapters(env: NodeJS.ProcessEnv = process.env): Map<string, StoreAdapter> {
  const list = [tesco, dunnes, ...(env.TEST_STORE_URL ? [testStore(env.TEST_STORE_URL)] : [])];
  return new Map(list.map((s) => [s.id, s]));
}
