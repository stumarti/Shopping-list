import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { setup } from "./helpers.js";

describe("first-time setup", () => {
  it("creates a person with their own token when the setup secret matches", async () => {
    const { app, register } = setup();
    const sam = await register("Sam");
    expect(sam.user.name).toBe("Sam");
    expect(sam.token.length).toBeGreaterThan(30);
    const me = await (await sam.call("/api/me")).json();
    expect(me.user).toEqual(sam.user);

    const bad = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "wrong", name: "Mallory" }),
    });
    expect(bad.status).toBe(401);
  });

  it("says when the setup token is missing rather than wrong", async () => {
    const { app } = setup();
    const post = (body: unknown) =>
      app.request("/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await (await post({ name: "Sam" })).json()).error).toBe("This server needs its setup token (APP_TOKEN from its .env).");
    expect((await (await post({ name: "Sam", setupToken: "nope" })).json()).error).toBe("That setup token doesn't match the server's APP_TOKEN.");
  });

  it("lets anyone set up when the server has no setup token", async () => {
    const app = createApp({ db: openDb(":memory:") });
    const res = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sam" }),
    });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect((await app.request("/api/state", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("rejects unknown tokens and the setup secret itself, but leaves health open", async () => {
    const { app, as } = setup();
    expect((await app.request("/api/state")).status).toBe(401);
    expect((await as("setup-secret").call("/api/state")).status).toBe(401);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("stores only hashes of tokens", async () => {
    const { db, register } = setup();
    const sam = await register("Sam");
    const rows = db.prepare("SELECT hash FROM tokens").all() as Array<{ hash: string }>;
    expect(rows.map((r) => r.hash)).not.toContain(sam.token);
  });
});

describe("invites", () => {
  it("lets a partner join as a new person, once", async () => {
    const { register, join, as } = setup();
    const sam = await register("Sam");
    const { code } = await (await sam.post("/api/invites")).json();

    expect((await join(code)).status).toBe(400); // name required for a new person
    const res = await join(code, "Alex");
    const body = await res.json();
    expect(body.user.name).toBe("Alex");

    const people = (await (await as(body.token).call("/api/me")).json()).people;
    expect(people.map((p: { name: string; isMe: boolean }) => [p.name, p.isMe])).toEqual([["Sam", false], ["Alex", true]]);

    expect((await join(code, "Again")).status).toBe(400);
  });

  it("adds another device for the same person", async () => {
    const { register, join } = setup();
    const sam = await register("Sam");
    const { code } = await (await sam.post("/api/invites", { forMe: true })).json();
    const body = await (await join(code)).json();
    expect(body.user.id).toBe(sam.user.id);
    const people = (await (await sam.call("/api/me")).json()).people;
    expect(people).toHaveLength(1);
    expect(people[0].devices).toBe(2);
  });

  it("refuses expired invites", async () => {
    const { db, register, join } = setup();
    const sam = await register("Sam");
    const { code } = await (await sam.post("/api/invites")).json();
    db.prepare("UPDATE invites SET expires_at = 0").run();
    expect((await join(code, "Alex")).status).toBe(400);
  });
});

describe("signing out", () => {
  it("logs out one device without touching the other", async () => {
    const { register, join, as } = setup();
    const sam = await register("Sam");
    const { code } = await (await sam.post("/api/invites", { forMe: true })).json();
    const ipad = as((await (await join(code)).json()).token);

    await ipad.post("/api/logout");
    expect((await ipad.call("/api/state")).status).toBe(401);
    expect((await sam.call("/api/state")).status).toBe(200);
  });

  it("revokes every device of a person (lost phone)", async () => {
    const { register, join, as } = setup();
    const sam = await register("Sam");
    const { code } = await (await sam.post("/api/invites")).json();
    const alex = await (await join(code, "Alex")).json();

    await sam.post(`/api/people/${alex.user.id}/revoke`);
    expect((await as(alex.token).call("/api/state")).status).toBe(401);
  });
});
