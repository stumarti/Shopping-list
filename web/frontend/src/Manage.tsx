import { useState, type FormEvent } from "react";
import { api, itemLinks, type CatalogItem, type Links } from "./api";

type Props = {
  catalog: CatalogItem[];
  categories: string[];
  links: Links | null;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

/** Build and tidy the list of common items: paste many at once, rename, move aisle, add barcodes, delete. */
export default function Manage({ catalog, categories, links, groupBy, run }: Props) {
  const [text, setText] = useState("");
  const [category, setCategory] = useState("Other");
  const [result, setResult] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const addMany = async (e: FormEvent) => {
    e.preventDefault();
    let summary = "";
    const ok = await run(async () => {
      const r = await api.addCommon(text, category);
      summary =
        (r.added.length ? `Added ${r.added.length}: ${r.added.join(", ")}.` : "Nothing new to add.") +
        (r.skipped.length ? ` Already there: ${r.skipped.join(", ")}.` : "");
    });
    if (ok) {
      setText("");
      setResult(summary);
    }
  };

  const f = filter.trim().toLowerCase();
  const shown = f ? catalog.filter((c) => c.name.toLowerCase().includes(f) || c.barcode.includes(f)) : catalog;

  return (
    <>
      <section aria-labelledby="bulk-heading">
        <h2 id="bulk-heading">Add common items</h2>
        <p className="muted">Paste or type one item per line. They'll all go in the aisle you pick.</p>
        <form onSubmit={addMany} className="bulk">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={"Kombucha\nOat milk\nKimchi"}
            aria-label="Items, one per line"
          />
          <div className="row">
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Aisle for these items">
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button type="submit" className="primary" disabled={!text.trim()}>
              Add to common items
            </button>
          </div>
        </form>
        {result && (
          <p className="muted" role="status">
            {result}
          </p>
        )}
      </section>

      <section aria-labelledby="edit-heading">
        <div className="section-head">
          <h2 id="edit-heading">Your common items</h2>
          <span className="muted">{catalog.length} items</span>
        </div>
        <p className="muted">
          Change a name, aisle or barcode and it saves when you move on. A barcode links the item to its{" "}
          {links?.barcodes.name ?? "barcode directory"} page.
        </p>
        <input
          type="search"
          className="filter"
          placeholder="Find an item or barcode…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Find a common item"
        />
        {groupBy(shown).map(([cat, items]) => (
          <div key={cat} className="group">
            <h3>{cat}</h3>
            <ul className="edit-list">
              {items.map((item) => (
                <EditRow key={`${item.id}:${item.name}:${item.category}:${item.barcode}`} {...{ item, categories, links, run }} />
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}

function EditRow({
  item,
  categories,
  links,
  run,
}: { item: CatalogItem; categories: string[]; links: Links | null; run: Props["run"] }) {
  const [name, setName] = useState(item.name);
  const [barcode, setBarcode] = useState(item.barcode);

  const save = (change: Partial<Pick<CatalogItem, "name" | "category" | "barcode">>) =>
    run(() => api.editCommon(item.id, change)).then((ok) => {
      // Put the field back if the server said no (a duplicate name, a bad barcode).
      if (!ok) {
        setName(item.name);
        setBarcode(item.barcode);
      }
    });

  return (
    <li>
      <input
        className="name"
        value={name}
        maxLength={80}
        aria-label="Name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== item.name ? save({ name }) : setName(item.name)}
      />
      <select value={item.category} aria-label={`Aisle for ${item.name}`} onChange={(e) => save({ category: e.target.value })}>
        {categories.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <input
        className="code"
        value={barcode}
        inputMode="numeric"
        maxLength={14}
        placeholder="Barcode"
        aria-label={`Barcode for ${item.name}`}
        onChange={(e) => setBarcode(e.target.value.replace(/\D/g, ""))}
        onBlur={() => barcode !== item.barcode && save({ barcode })}
      />
      <span className="links">
        {itemLinks(links, item).map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noreferrer" title={l.title}>
            {l.label}
          </a>
        ))}
      </span>
      <button className="remove" aria-label={`Delete ${item.name}`} title="Delete" onClick={() => run(() => api.forget(item.id))}>
        ×
      </button>
    </li>
  );
}
