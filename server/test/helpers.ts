import { createApp } from "../src/app.js";
import type { Assistant } from "../src/claude.js";
import { openDb } from "../src/db.js";

export const SETUP = "setup-secret";

export function setup(extra: { assistant?: Assistant; fetchFn?: typeof fetch } = {}) {
  const db = openDb(":memory:");
  const app = createApp({ db, setupToken: SETUP, ...extra });

  const as = (token: string) => {
    const call = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
      });
    const post = async (path: string, body: unknown = {}) => call(path, { method: "POST", body: JSON.stringify(body) });
    const sync = async (ops: unknown[]) => (await post("/api/sync", { ops })).json();
    return { token, call, post, sync };
  };

  const register = async (name: string) => {
    const res = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: SETUP, name, device: "iPhone" }),
    });
    const body = (await res.json()) as { user: { id: string; name: string }; token: string };
    return { ...as(body.token), user: body.user };
  };

  const join = async (code: string, name?: string) =>
    app.request("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, device: "iPad" }) });

  return { db, app, as, register, join };
}

export const milk = { id: "i1", name: "Whole milk", sectionId: "dairy", brand: "Avonmore", size: "2 L" };
