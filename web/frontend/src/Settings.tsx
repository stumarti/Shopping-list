import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, type Aisle, type FinderStatus, type NutritionStatus } from "./api";

type Props = {
  categories: string[];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const fmt = (iso: string) =>
  new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });

export default function Settings({ categories, run }: Props) {
  // Bumped when new items arrive, so the barcode section recounts what it can look up.
  const [itemsChanged, setItemsChanged] = useState(0);
  const bump = () => setItemsChanged((n) => n + 1);
  return (
    <>
      <ClubcardUpload run={run} onDone={bump} />
      <BarcodeFinder itemsChanged={itemsChanged} />
      <NutritionFiller itemsChanged={itemsChanged} />
      <Aisles run={run} />
      <AddCommon categories={categories} run={run} onDone={bump} />
      <StartAgain run={run} onDone={bump} />
    </>
  );
}

function ClubcardUpload({ run, onDone }: { run: Props["run"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setNote(null);
    await run(async () => {
      const r = await api.importClubcard(file);
      setNote(
        r.new_trips
          ? `Added ${r.new_trips} shopping trips from ${fmt(r.from)} to ${fmt(r.to)}` +
              (r.already_imported ? ` (${r.already_imported} were already here)` : "") +
              `, and ${r.new_common_items} new common items.` +
              (r.not_groceries
                ? ` ${r.not_groceries} non-grocery ${r.not_groceries === 1 ? "line" : "lines"} (clothes, bags) kept but left out of the figures.`
                : "") +
              ` The file is saved as ${r.saved_as}.`
          : `All ${r.trips} trips in that file were already here.`,
      );
      onDone();
    });
    setBusy(false);
  };

  return (
    <section aria-labelledby="upload-heading">
      <h2 id="upload-heading">Tesco Clubcard data</h2>
      <p className="muted">
        Everything you've bought with your Clubcard, in store and online. On tesco.ie: <em>My account → Request your Tesco data</em>. When the
        email arrives, download the file and upload it here as it is (.json or .zip). Nothing in it is thrown away, and uploading a newer one
        only adds the new trips.
      </p>
      <label className={`upload${busy ? " busy" : ""}`}>
        <input type="file" accept=".json,.zip,application/json,application/zip" onChange={upload} disabled={busy} />
        {busy ? "Reading…" : "Upload Tesco data file"}
      </label>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

function BarcodeFinder({ itemsChanged }: { itemsChanged: number }) {
  const [s, setS] = useState<FinderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = async (call: Promise<FinderStatus> = api.finder()) => {
    clearTimeout(timer.current);
    try {
      const next = await call;
      setS(next);
      setError(null);
      if (next.running) timer.current = setTimeout(() => void poll(), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };
  useEffect(() => {
    void poll();
    return () => clearTimeout(timer.current);
  }, [itemsChanged]);

  const undo = async (id: number) => {
    try {
      await api.editCommon(id, { barcode: "" });
      setS((cur) => cur && { ...cur, found: cur.found.filter((f) => f.catalog_id !== id) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't undo that.");
    }
  };

  const minutes = s ? Math.ceil(((s.running ? s.total - s.done : s.waiting) * 6.5) / 60) : 0;

  return (
    <section aria-labelledby="barcodes-heading">
      <h2 id="barcodes-heading">Find barcodes</h2>
      <p className="muted">
        Looks your common items up in Open Food Facts by name, and gives each one a barcode when the product found clearly matches. Open Food
        Facts allows about 10 searches a minute, so it works through them in the background: you can leave this page.
      </p>
      {error && <p className="error-text">{error}</p>}
      {s?.running ? (
        <>
          <progress max={s.total} value={s.done} aria-label="Barcode search progress" />
          <p className="muted" role="status">
            {s.done} of {s.total} searched, {s.found.length} found
            {s.current && `. Now: ${s.current}`}. About {minutes} {minutes === 1 ? "minute" : "minutes"} left.
          </p>
          <button className="link" onClick={() => poll(api.stopFinding())}>
            Stop
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <button className="primary" disabled={!s || s.waiting === 0} onClick={() => poll(api.findBarcodes(false))}>
              {s && s.waiting ? `Find barcodes for ${s.waiting} items` : "Nothing new to look up"}
            </button>
            <button className="link" onClick={() => poll(api.findBarcodes(true))}>
              Try again for items with none
            </button>
          </div>
          {s && s.waiting > 0 && (
            <p className="muted">
              That takes about {minutes} {minutes === 1 ? "minute" : "minutes"}.
            </p>
          )}
          {s?.error && <p className="error-text">{s.error}</p>}
          {s && s.total > 0 && !s.error && (
            <p className="muted" role="status">
              Last run: searched {s.done} of {s.total}, found {s.found.length}.
            </p>
          )}
        </>
      )}
      {!!s?.found.length && (
        <>
          <h3>Found</h3>
          <ul className="found-list">
            {s.found.map((f) => (
              <li key={f.catalog_id}>
                <span>
                  {f.name}
                  <span className="muted">
                    {" "}
                    → {f.product || "product"} ·{" "}
                    <a href={`https://world.${f.source}.org/product/${f.barcode}`} target="_blank" rel="noreferrer">
                      {f.barcode}
                    </a>
                  </span>
                </span>
                <button className="link" onClick={() => undo(f.catalog_id)}>
                  Not this
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Aisles({ run }: { run: Props["run"] }) {
  const [aisles, setAisles] = useState<Aisle[]>([]);
  const [newName, setNewName] = useState("");
  const [removing, setRemoving] = useState<Aisle | null>(null);
  const [moveTo, setMoveTo] = useState<number | null>(null);

  const load = () => api.aisles().then(setAisles, () => setAisles([]));
  useEffect(() => {
    void load();
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    await run(action);
    await load();
  };

  const move = (i: number, by: number) => {
    const ids = aisles.map((a) => a.id);
    const [moved] = ids.splice(i, 1);
    ids.splice(i + by, 0, moved);
    void act(() => api.orderAisles(ids));
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    void act(() => api.addAisle(newName.trim())).then(() => setNewName(""));
  };

  return (
    <section aria-labelledby="aisles-heading">
      <h2 id="aisles-heading">Aisles</h2>
      <p className="muted">In the order you walk round the shop. Your list and common items follow this order.</p>
      <ol className="aisle-list">
        {aisles.map((a, i) => (
          <li key={a.id}>
            <AisleName aisle={a} onRename={(name) => act(() => api.renameAisle(a.id, name))} />
            <span className="muted count">{a.items}</span>
            <span className="aisle-actions">
              <button aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button aria-label={`Move ${a.name} down`} disabled={i === aisles.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button
                aria-label={`Remove ${a.name}`}
                disabled={a.fallback}
                title={a.fallback ? "Unsorted things go here, so it can't be removed" : "Remove"}
                onClick={() => {
                  setRemoving(a);
                  setMoveTo(aisles.find((x) => x.fallback)?.id ?? null);
                }}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      {removing && (
        <div className="confirm" role="alertdialog" aria-labelledby="remove-title">
          <p id="remove-title">
            Remove <strong>{removing.name}</strong>?{" "}
            {removing.items > 0 && `Its ${removing.items} ${removing.items === 1 ? "item moves" : "items move"} to:`}
          </p>
          <div className="row">
            {removing.items > 0 && (
              <select value={moveTo ?? ""} onChange={(e) => setMoveTo(Number(e.target.value))} aria-label="Move its items to">
                {aisles
                  .filter((a) => a.id !== removing.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            )}
            <button
              className="primary"
              onClick={() => {
                const r = removing;
                setRemoving(null);
                void act(() => api.removeAisle(r.id, moveTo));
              }}
            >
              Remove
            </button>
            <button className="link" onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <form className="row add-aisle" onSubmit={add}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New aisle, e.g. Baby" maxLength={40} aria-label="New aisle name" />
        <button type="submit" className="primary" disabled={!newName.trim()}>
          Add aisle
        </button>
      </form>
    </section>
  );
}

function AisleName({ aisle, onRename }: { aisle: Aisle; onRename: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(aisle.name);
  useEffect(() => setName(aisle.name), [aisle.name]);
  return (
    <input
      className="aisle-name"
      value={name}
      maxLength={40}
      aria-label={`Rename ${aisle.name}`}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => (name.trim() && name.trim() !== aisle.name ? void onRename(name.trim()) : setName(aisle.name))}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function AddCommon({ categories, run, onDone }: Props & { onDone: () => void }) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const aisle = category || categories[categories.length - 1] || "Other";

  const addMany = async (e: FormEvent) => {
    e.preventDefault();
    let summary = "";
    const ok = await run(async () => {
      const r = await api.addCommon(text, aisle);
      summary =
        (r.added.length ? `Added ${r.added.length}: ${r.added.join(", ")}.` : "Nothing new to add.") +
        (r.skipped.length ? ` Already there: ${r.skipped.join(", ")}.` : "");
    });
    if (ok) {
      setText("");
      setResult(summary);
      onDone();
    }
  };

  return (
    <section aria-labelledby="bulk-heading">
      <h2 id="bulk-heading">Add common items</h2>
      <p className="muted">One item per line. They all go in the aisle you pick.</p>
      <form onSubmit={addMany} className="bulk">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={"Kombucha\nOat milk"} aria-label="Items, one per line" />
        <div className="row">
          <select value={aisle} onChange={(e) => setCategory(e.target.value)} aria-label="Aisle for these items">
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={!text.trim()}>
            Add
          </button>
        </div>
      </form>
      {result && (
        <p className="muted" role="status">
          {result}
        </p>
      )}
    </section>
  );
}

function StartAgain({ run, onDone }: { run: Props["run"]; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);

  const clear = () => {
    if (!confirm("Remove all common items? Your list, purchase history and uploaded files stay.")) return;
    void run(async () => {
      const r = await api.clearCommon();
      setNote(`Removed ${r.removed} common items.`);
      onDone();
    });
  };

  const rebuild = () =>
    run(async () => {
      const r = await api.rebuildCommon();
      setNote(
        r.added || r.purchases
          ? `Made ${r.added} common items from ${r.purchases} past purchases.`
          : "Nothing to rebuild: every past purchase already belongs to a common item.",
      );
      onDone();
    });

  return (
    <section aria-labelledby="start-heading">
      <h2 id="start-heading">Start again</h2>
      <p className="muted">
        Clear out the common items and make them again from your shopping history: every product from an online order, and anything
        you've bought on two or more trips. Your list, history and uploaded files are never touched.
      </p>
      <div className="row">
        <button className="link danger" onClick={clear}>
          Remove all common items
        </button>
        <button className="primary" onClick={rebuild}>
          Rebuild from history
        </button>
      </div>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
    </section>
  );
}


const FIGURE_NAMES: Record<string, string> = { kcal: "calories", protein: "protein", carbs: "carbs", fat: "fat" };

/** Fill calories and macros for every item with a barcode, from Open Food Facts, in the background. */
function NutritionFiller({ itemsChanged }: { itemsChanged: number }) {
  const [s, setS] = useState<NutritionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const poll = async (call: Promise<NutritionStatus> = api.nutritionStatus()) => {
    clearTimeout(timer.current);
    try {
      const next = await call;
      setS(next);
      setError(null);
      if (next.running) timer.current = setTimeout(() => void poll(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };
  useEffect(() => {
    void poll();
    return () => clearTimeout(timer.current);
  }, [itemsChanged]);

  return (
    <section aria-labelledby="nutrition-heading">
      <h2 id="nutrition-heading">Fill calories and macros</h2>
      <p className="muted">
        For items with a barcode, looks it up in Open Food Facts and fills calories, protein, carbs and fat for the whole pack (from the per
        100 g figures and the pack size). Only empty ones are filled: anything you've typed stays.
      </p>
      {error && <p className="error-text">{error}</p>}
      {s?.running ? (
        <>
          <progress max={s.total} value={s.done} aria-label="Nutrition lookup progress" />
          <p className="muted" role="status">
            {s.done} of {s.total} looked up, {s.filled.length} filled{s.current && `. Now: ${s.current}`}.
          </p>
          <button className="link" onClick={() => poll(api.stopFillingNutrition())}>
            Stop
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <button className="primary" disabled={!s || s.waiting === 0} onClick={() => poll(api.fillAllNutrition(false))}>
              {s && s.waiting ? `Fill ${s.waiting} ${s.waiting === 1 ? "item" : "items"}` : "Nothing new to fill"}
            </button>
            <button className="link" onClick={() => poll(api.fillAllNutrition(true))}>
              Try again for ones with gaps
            </button>
          </div>
          {s?.error && <p className="error-text">{s.error}</p>}
          {s && s.total > 0 && !s.error && (
            <p className="muted" role="status">
              Last run: looked up {s.done} of {s.total}, filled {s.filled.length}.
            </p>
          )}
        </>
      )}
      {!!s?.filled.length && (
        <ul className="found-list">
          {s.filled.map((f) => (
            <li key={f.catalog_id}>
              <span>
                {f.name}
                <span className="muted">
                  {" "}
                  · {f.filled.map((x) => FIGURE_NAMES[x]).join(", ")}
                  {f.kcal !== undefined && ` · ${f.kcal} kcal`} · {f.basis}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
