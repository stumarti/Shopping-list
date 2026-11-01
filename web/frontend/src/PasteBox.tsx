import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, type ClubcardResult, type PasteDone, type Pasted } from "./api";
import Icon from "./Icon";

const STORES: Record<string, string> = { tesco: "Tesco", dunnes: "Dunnes" };
const fmt = (iso: string) =>
  new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
const span = (from: string, to: string) => (from === to ? `on ${fmt(from)}` : `from ${fmt(from)} to ${fmt(to)}`);
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-IE")} ${n === 1 ? one : many}`;

/** What a Clubcard import did, in a sentence. */
function clubcardNote(r: ClubcardResult) {
  return r.new_trips
    ? `Added ${plural(r.new_trips, "shopping trip")} ${span(r.from, r.to)}` +
        (r.already_imported ? ` (${r.already_imported} were already here)` : "") +
        `, and ${plural(r.new_common_items, "new item")}.` +
        (r.not_groceries
          ? ` ${plural(r.not_groceries, "non-grocery line")} (clothes, bags) kept but left out of the figures.`
          : "") +
        ` The file is saved as ${r.saved_as}.`
    : `All ${r.trips} trips in that were already here.`;
}

/** What's in the paste, and what the button will do with it. */
function describe(p: Pasted, store: string): { title: string; detail: string; action: string } {
  switch (p.kind) {
    case "clubcard":
      return {
        title: "Tesco Clubcard data",
        detail: `${plural(p.trips, "shopping trip")} ${span(p.from, p.to)}, ${plural(p.products, "product")}. Trips already here are skipped.`,
        action: "Import trips",
      };
    case "orders": {
      const by = Object.entries(
        p.orders.reduce<Record<string, number>>((n, o) => ({ ...n, [o.store]: (n[o.store] ?? 0) + 1 }), {}),
      ).map(([s, n]) => `${n} from ${STORES[s] ?? s}`);
      return {
        title: p.orders.length === 1 ? "A past online order" : "Past online orders",
        detail:
          `${plural(p.orders.length, "order")} (${by.join(", ")}), ${plural(p.products, "product")}` +
          (p.from ? `, ${span(p.from, p.to)}` : "") +
          ". Orders already here are skipped.",
        action: p.orders.length === 1 ? "Import order" : "Import orders",
      };
    }
    case "basket":
      return {
        title: `Claude's basket results${store ? ` for ${STORES[store]}` : ""}`,
        detail:
          `${plural(p.counts.added, "thing")} in the basket, ${p.counts.swapped} swapped, ${p.counts.missing} missing` +
          (p.total ? `, ${p.total} in all` : "") +
          ". Checking it shows what's still to find on Shop online.",
        action: "Check the basket",
      };
    case "list":
      return {
        title: p.items.length === 1 ? "Something to get" : "Things to get",
        detail: p.items.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(", "),
        action: `Add ${plural(p.items.length, "thing")} to the list`,
      };
  }
}

function doneNote(d: PasteDone) {
  switch (d.kind) {
    case "clubcard":
      return clubcardNote(d.result);
    case "orders": {
      const r = d.result;
      return r.products
        ? `Added ${plural(r.products, "product")} to your history, and ${plural(r.new_common_items, "new item")}.` +
            (r.already_imported ? ` ${plural(r.already_imported, "order was", "orders were")} already here.` : "")
        : "Those orders were already here.";
    }
    case "basket": {
      const c = d.result?.counts;
      return c
        ? `Checked the ${STORES[d.result!.store] ?? ""} basket: ${c.added} in, ${c.swapped} swapped, ${c.missing} missing. The details are on Shop online.`
        : "Checked the basket. The details are on Shop online.";
    }
    case "list":
      return `Added to your list: ${d.result.names.join(", ")}.`;
  }
}

/**
 * One box for anything that updates Press: paste (or drop a file) and it works out what it is: Tesco's
 * Clubcard data, past online orders, Claude's basket results, or a list of things to get. It says what
 * it found before doing anything.
 */
export default function PasteBox({ run, onDone }: { run: (action: () => Promise<unknown>) => Promise<boolean>; onDone: () => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [found, setFound] = useState<Pasted | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [store, setStore] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const asked = useRef(0);

  const body = file ?? text;
  const empty = !file && !text.trim();

  // Work out what it is, a moment after typing stops (straight away for a file).
  useEffect(() => {
    setFound(null);
    setProblem(null);
    if (empty) return;
    const n = ++asked.current;
    const t = setTimeout(
      () =>
        api.pasteCheck(body).then(
          (p) => {
            if (n !== asked.current) return;
            setFound(p);
            setStore(p.kind === "basket" ? (p.store ?? "") : "");
          },
          (e) => n === asked.current && setProblem(e instanceof Error ? e.message : "Couldn't read that."),
        ),
      file ? 0 : 400,
    );
    return () => clearTimeout(t);
  }, [text, file]);

  const clear = () => {
    setText("");
    setFile(null);
  };

  const apply = async () => {
    setBusy(true);
    let done: PasteDone | null = null;
    const ok = await run(async () => {
      done = await api.pasteApply(body, store || undefined);
    });
    setBusy(false);
    if (ok && done) {
      setNote(doneNote(done));
      clear();
      onDone();
    }
  };

  const drop = (e: DragEvent) => {
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return; // dropped text lands in the box as usual
    e.preventDefault();
    setNote(null);
    setFile(f);
  };

  const what = found && describe(found, store);

  return (
    <section aria-labelledby="paste-heading" className="paste-box">
      <h2 id="paste-heading">
        <Icon name="paste" /> Paste or drop
      </h2>
      <p className="muted">
        Anything that updates Press goes here: Tesco's Clubcard data file, past online orders, Claude's reply after filling your basket, or a
        list of things to get (one per line, like <em>2 x milk</em>). It says what it found before changing anything, and anything
        already here is skipped.
      </p>
      <details className="paste-help">
        <summary>Where to get each one</summary>
        <ul className="muted">
          <li>
            <strong>Tesco Clubcard data</strong>: everything you've bought with your Clubcard, in store and online. On tesco.ie,{" "}
            <em>My account → Request your Tesco data</em>. When the email arrives, download the file and drop it here as it is (.json or
            .zip). Nothing in it is thrown away; a newer file only adds the new trips.
          </li>
          <li>
            <strong>Claude's basket results</strong>: after Claude in Chrome fills your basket from the Shop online prompt, copy its whole
            reply. The block at the end says what went in, what was swapped and what's missing.
          </li>
          <li>
            <strong>Past online orders</strong>: the browser helper sends these by itself; if it gives you JSON instead, paste it here.
          </li>
        </ul>
      </details>
      <div
        className={`paste-zone${over ? " over" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        {file ? (
          <p className="paste-file">
            <strong>{file.name}</strong> <span className="muted">({Math.max(1, Math.round(file.size / 1024)).toLocaleString("en-IE")} KB)</span>
          </p>
        ) : (
          <textarea
            value={text}
            onChange={(e) => {
              setNote(null);
              setText(e.target.value);
            }}
            rows={5}
            placeholder={'Paste here, or drop a file\n\n{"purchases": [...]}   ·   Claude\'s reply   ·   2 x milk'}
            aria-label="Paste anything that updates Press"
            spellCheck={false}
          />
        )}
        <div className="paste-actions">
          <label className="upload subtle">
            <input
              type="file"
              accept=".json,.zip,.txt,application/json,application/zip,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) {
                  setNote(null);
                  setFile(f);
                }
              }}
            />
            Choose a file
          </label>
          {!empty && (
            <button type="button" onClick={clear}>
              Clear
            </button>
          )}
        </div>
      </div>

      {problem && (
        <p className="paste-found problem" role="status">
          <Icon name="unknown" /> {problem}
        </p>
      )}
      {what && found && (
        <div className="paste-found" role="status">
          <Icon name="checked" />
          <div>
            <strong>{what.title}</strong>
            <p className="muted">{what.detail}</p>
            {found.kind === "basket" && (
              <div className="order paste-store" role="radiogroup" aria-label="Which store">
                {Object.entries(STORES).map(([id, name]) => (
                  <button key={id} role="radio" aria-checked={store === id} aria-pressed={store === id} onClick={() => setStore(id)}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            <button className="primary" onClick={apply} disabled={busy || (found.kind === "basket" && !store)}>
              {busy ? "Working…" : found.kind === "basket" && !store ? "Pick the store first" : what.action}
            </button>
          </div>
        </div>
      )}
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
