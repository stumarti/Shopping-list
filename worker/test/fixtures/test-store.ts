import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny pretend supermarket for tests and demos: sign-in, a booked slot, search, product pages and a
 * basket. Run it with `npx tsx test/fixtures/test-store.ts` and set TEST_STORE_URL to try the whole
 * ordering flow without a real store.
 */
export const CATALOG = [
  { id: "p1", name: "Avonmore Fresh Whole Milk", size: "2 L", price: 2.39, member: 2.1 },
  { id: "p2", name: "Avonmore Fresh Whole Milk", size: "1 L", price: 1.45 },
  { id: "p3", name: "Store Brand Whole Milk", size: "2 L", price: 1.99 },
  { id: "p4", name: "Brennans Family Pan White Bread", size: "800 g", price: 2.25 },
  { id: "p5", name: "Store Brand Sourdough Loaf", size: "400 g", price: 2.75 },
  { id: "p6", name: "Free Range Large Eggs", size: "12 pack", price: 4.49 },
  { id: "p7", name: "Alpro Oat Drink", size: "1 L", price: 2.6, available: false },
  { id: "p8", name: "Oatly Oat Drink Barista", size: "1 L", price: 2.99 },
];

interface Session {
  signedIn: boolean;
  basket: Map<string, number>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><header>Test Store</header>${body}</body></html>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function startTestStore(opts: { port?: number; slot?: string | null } = {}) {
  const sessions = new Map<string, Session>();
  let slot = opts.slot === undefined ? "Click & collect · Sat 18 Oct, 14:00–15:00" : opts.slot;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://store");
    const sid = /sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const html = (status: number, content: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(content);
    };
    const redirect = (to: string, cookie?: string) => {
      res.writeHead(303, { location: to, ...(cookie ? { "set-cookie": cookie } : {}) });
      res.end();
    };

    if (url.pathname === "/login" && req.method === "POST") {
      if (!form.get("email") || form.get("password") !== "correct-horse") return html(401, page("Sign in", "<p>Wrong email or password</p>"));
      const id = randomUUID();
      sessions.set(id, { signedIn: true, basket: new Map() });
      return redirect("/account", `sid=${id}; Path=/; HttpOnly`);
    }
    if (url.pathname === "/login") {
      return html(
        200,
        page(
          "Sign in",
          `<form method="post" action="/login" style="display:grid;gap:12px;padding:16px"><h1>Sign in</h1>
          <label>Email <input name="email" type="email" style="width:100%;font-size:18px"></label>
          <label>Password <input name="password" type="password" style="width:100%;font-size:18px"></label>
          <button style="font-size:18px;padding:12px">Sign in</button></form>`,
        ),
      );
    }
    if (url.pathname === "/account") {
      return html(200, page("Account", s?.signedIn ? `<p data-testid="signed-in">Signed in</p>` : `<a href="/login">Sign in</a>`));
    }
    if (url.pathname === "/slot") {
      if (!s?.signedIn) return redirect("/login");
      return html(200, page("Slot", slot ? `<p data-testid="slot" data-kind="collect">${esc(slot)}</p>` : `<p>No slot booked</p>`));
    }
    if (url.pathname === "/search") {
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const hits = CATALOG.filter((p) => words.some((w) => `${p.name} ${p.size}`.toLowerCase().includes(w)));
      const tiles = hits
        .map(
          (p) => `<article data-testid="product" data-id="${p.id}" data-price="${p.price}" data-member-price="${p.member ?? ""}" data-size="${esc(p.size)}" data-available="${p.available !== false}">
            <h2 data-testid="name">${esc(p.name)} ${esc(p.size)}</h2><p>€${p.price.toFixed(2)}</p></article>`,
        )
        .join("");
      return html(200, page("Search", tiles || "<p>No results</p>"));
    }
    const product = /^\/product\/([\w-]+)$/.exec(url.pathname);
    if (product) {
      const p = CATALOG.find((x) => x.id === product[1]);
      if (!p) return html(404, page("Not found", "<p>Not found</p>"));
      if (req.method === "POST") {
        if (!s?.signedIn) return redirect("/login");
        if (p.available === false) return html(409, page(p.name, "<p>Out of stock</p>"));
        s.basket.set(p.id, (s.basket.get(p.id) ?? 0) + Number(form.get("qty") || 1));
        return redirect(`/product/${p.id}?added=1`);
      }
      return html(
        200,
        page(
          p.name,
          `<h1>${esc(p.name)} ${esc(p.size)}</h1>${url.searchParams.get("added") ? '<p data-testid="added">Added to basket</p>' : ""}
          <form method="post"><label>Quantity <input name="qty" type="number" value="1"></label><button>Add to basket</button></form>`,
        ),
      );
    }
    if (url.pathname === "/basket") {
      const rows = [...(s?.basket ?? [])].map(([id, n]) => `<li>${n} × ${esc(CATALOG.find((p) => p.id === id)!.name)}</li>`).join("");
      return html(200, page("Basket", `<ul>${rows}</ul>`));
    }
    return html(200, page("Home", `<a href="/login">Sign in</a>`));
  });

  return new Promise<{ url: string; close: () => void; baskets: () => Array<Record<string, number>>; setSlot: (s: string | null) => void }>((resolve) => {
    server.listen(opts.port ?? 0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}`,
        close: () => server.close(),
        baskets: () => [...sessions.values()].map((x) => Object.fromEntries(x.basket)),
        setSlot: (v) => {
          slot = v;
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTestStore({ port: Number(process.env.PORT || 8099) }).then((s) => console.log(`test store on ${s.url} (password: correct-horse)`));
}
