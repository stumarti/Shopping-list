import { useEffect, useState, type ChangeEvent } from "react";
import { api, type History as HistoryData, type ItemHistory } from "./api";

type Props = {
  storeName: string;
  onList: Set<string>;
  listSize: number;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const euro = (n: number) => `€${n.toFixed(2)}`;
const formatDate = (iso: string) =>
  new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
const daysSince = (iso: string) => Math.floor((Date.now() - new Date(iso + "T12:00:00").getTime()) / 86_400_000);

/** Past orders and Clubcard shopping: what you buy, how often, and what it costs. */
export default function History({ storeName, onList, listSize, run }: Props) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = () => api.history().then(setHistory, () => setHistory(null));
  useEffect(() => {
    void load();
  }, [listSize]);

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadNote(null);
    await run(async () => {
      const r = await api.importClubcard(file);
      setUploadNote(
        r.new_trips
          ? `Added ${r.new_trips} shopping trips from ${formatDate(r.from)} to ${formatDate(r.to)}` +
              (r.already_imported ? ` (${r.already_imported} were already here)` : "") +
              `. ${r.new_common_items} new common items.` +
              (r.not_groceries
                ? ` ${r.not_groceries} non-grocery ${r.not_groceries === 1 ? "line" : "lines"} (clothes, bags) kept but left out of the figures.`
                : "")
          : `All ${r.trips} trips in that file were already imported.`,
      );
      await load();
    });
    setUploading(false);
  };

  const trips = history?.orders ?? [];
  const clubcard = trips.filter((o) => o.source.startsWith("clubcard")).length;

  return (
    <section aria-labelledby="orders-heading">
      <h2 id="orders-heading">Past shopping</h2>
      {trips.length ? (
        <p className="muted">
          {trips.length} trips: {trips.length - clubcard} online orders and {clubcard} from your Clubcard data, most recently{" "}
          {formatDate(trips[0].bought_on)}.
        </p>
      ) : (
        <p className="muted">Bring in what you've bought before, so the list knows your usual items, how often you buy them and what they cost.</p>
      )}

      <div className="import-ways">
        <div>
          <strong>Tesco Clubcard data</strong>
          <p className="muted">
            Everything you've bought with your Clubcard, in store and online. On tesco.ie: <em>My account → Request your Tesco data</em>. When
            the email arrives, download the file and upload it here as it is.
          </p>
          <label className={`upload${uploading ? " busy" : ""}`}>
            <input type="file" accept=".json,.zip,application/json,application/zip" onChange={upload} disabled={uploading} />
            {uploading ? "Reading…" : "Upload Tesco data file"}
          </label>
          {uploadNote && (
            <p className="muted" role="status">
              {uploadNote}
            </p>
          )}
        </div>
        <div>
          <strong>Online orders</strong>
          <p className="muted">
            Saves each product's {storeName} link too, so <em>Fill basket</em> can add it. Open an order on the store's site and press{" "}
            <em>Import this order</em> in the helper's panel.
          </p>
        </div>
      </div>

      {!!history?.usual.length && (
        <>
          <h3>You often buy</h3>
          <ul className="usual">
            {history.usual.slice(0, 30).map((u) => {
              const qty = Math.max(1, Math.round(u.usual_qty));
              const already = onList.has(u.name.toLowerCase());
              const due = u.every_days !== null && daysSince(u.last_bought) >= u.every_days;
              const change = u.price ? Math.round((u.price.now - u.price.first) * 100) : 0;
              return (
                <li key={u.catalog_id}>
                  <div className="usual-row">
                    <button className="usual-name" aria-expanded={open === u.catalog_id} onClick={() => setOpen(open === u.catalog_id ? null : u.catalog_id)}>
                      {u.name}
                      {due && !already && <span className="due">due</span>}
                    </button>
                    <button className="link" disabled={already} onClick={() => run(() => api.add(u.name, u.category, qty))}>
                      {already ? "On the list" : `Add${qty > 1 ? ` ${qty}` : ""}`}
                    </button>
                  </div>
                  <p className="muted usual-meta">
                    {u.orders}× {u.every_days !== null && `· about every ${u.every_days === 7 ? "week" : `${u.every_days} days`} `}· last{" "}
                    {formatDate(u.last_bought)}
                    {u.price && (
                      <>
                        {" "}
                        · {euro(u.price.now)}
                        {change !== 0 && (
                          <span className={change > 0 ? "up" : "down"}>
                            {" "}
                            {change > 0 ? "▲" : "▼"} {Math.abs(change)}c since {formatDate(u.price.first_on)}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                  {open === u.catalog_id && <Timeline id={u.catalog_id} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Timeline({ id }: { id: number }) {
  const [data, setData] = useState<ItemHistory | null>(null);
  useEffect(() => {
    api.itemHistory(id).then(setData, () => setData(null));
  }, [id]);
  if (!data) return <p className="muted timeline">Loading…</p>;
  const p = data.summary.price;
  return (
    <div className="timeline">
      {p && (
        <p className="muted">
          Paid between {euro(p.low)} and {euro(p.high)} each.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Qty</th>
            <th scope="col">Each</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          {[...data.purchases].reverse().map((row, i) => (
            <tr key={i}>
              <td>
                {formatDate(row.bought_at || row.bought_on)}
                {row.bought_at.length > 10 && <span className="muted"> {row.bought_at.slice(11, 16)}</span>}
              </td>
              <td>{row.qty}</td>
              <td>{row.unit_price === null ? "–" : euro(row.unit_price)}</td>
              <td className="muted">{row.source === "order" ? "online order" : row.source.replace("clubcard ", "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
