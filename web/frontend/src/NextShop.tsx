import { useEffect, useState, type FormEvent } from "react";
import { api, type NextShop as Plan, type ShopItem } from "./api";

type Props = {
  listSize: number;
  groupBy: <T extends { category: string }>(items: T[]) => [string, T[]][];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const day = (iso: string) => new Date(iso + "T12:00:00");
const daysAway = (iso: string) => {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  return Math.round((day(iso).getTime() - t.getTime()) / 86_400_000);
};
const when = (iso: string) => {
  const d = daysAway(iso);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
};

/** The next shop: when it's likely to be, and everything it needs, aisle by aisle. */
export default function NextShop({ listSize, groupBy, run }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [undo, setUndo] = useState<ShopItem | null>(null);
  const [text, setText] = useState("");

  const load = () => api.nextShop().then(setPlan, () => setPlan(null));
  useEffect(() => {
    void load();
  }, [listSize]);

  const remove = (item: ShopItem) =>
    run(async () => {
      if (item.catalog_id !== null) setPlan(await api.skipForShop(item.catalog_id));
      else if (item.list_item_id !== null) {
        await api.remove(item.list_item_id);
        await load();
      }
      setUndo(item);
    });

  const putBack = (item: ShopItem) =>
    run(async () => {
      if (item.catalog_id !== null) setPlan(await api.unskipForShop(item.catalog_id));
      else await api.add(item.name, item.category, item.qty);
      await load();
      setUndo(null);
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (!name) return;
    setText("");
    void run(async () => {
      await api.add(name, "");
      await load();
    });
  };

  if (!plan) return <section><p className="muted">Loading…</p></section>;
  const unsure = plan.items.filter((i) => i.badge === "unsure").length;

  return (
    <>
      <section aria-labelledby="shop-when" className="shop-when">
        {plan.shop ? (
          <>
            <p className="muted eyebrow">Next shop</p>
            <h2 id="shop-when">
              {day(plan.shop.date).toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long" })}{" "}
              <span className="muted">({when(plan.shop.date)})</span>
            </h2>
            <p className="muted">
              {plan.shop.reason}. Last shop {day(plan.shop.last_shop).toLocaleDateString("en-IE", { weekday: "short", day: "numeric", month: "short" })}.
            </p>
          </>
        ) : (
          <>
            <h2 id="shop-when">Next shop</h2>
            <p className="muted">
              Upload your Tesco data in <a href="#settings">Settings</a> and this works out when you'll shop next and what you'll need.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="shop-items">
        <div className="section-head">
          <h2 id="shop-items">What you'll need</h2>
          <span className="muted">
            {plan.items.length} {plan.items.length === 1 ? "item" : "items"}
            {unsure > 0 && ` · ${unsure} not sure`}
          </span>
        </div>
        {undo && (
          <p className="undo" role="status">
            Removed {undo.name}.{" "}
            <button className="link" onClick={() => putBack(undo)}>
              Undo
            </button>
          </p>
        )}
        {plan.items.length === 0 && <p className="empty">Nothing yet. Add anything you need below.</p>}
        {groupBy(plan.items).map(([aisle, items]) => (
          <div key={aisle} className="group">
            <h3>{aisle}</h3>
            <ul className="shop-items">
              {items.map((i) => (
                <li key={`${i.catalog_id ?? "l" + i.list_item_id}`} className={i.badge}>
                  <div className="shop-item-main">
                    <span className="shop-item-name">
                      {i.name}
                      {i.qty > 1 && <span className="muted"> ×{i.qty}</span>}
                    </span>
                    <span className="shop-item-meta">
                      <span className={`badge ${i.badge}`}>{i.label}</span>
                      <span className="muted">{i.detail}</span>
                    </span>
                  </div>
                  <button className="remove" aria-label={`Remove ${i.name} from this shop`} title="Remove from this shop" onClick={() => remove(i)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <form className="add-form shop-add" onSubmit={add}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something else…" aria-label="Add an item" maxLength={80} />
          <button type="submit" className="primary" disabled={!text.trim()}>
            Add
          </button>
        </form>
        {plan.skipped.length > 0 && (
          <details className="skipped">
            <summary>Removed from this shop ({plan.skipped.length})</summary>
            <ul>
              {plan.skipped.map((i) => (
                <li key={i.catalog_id}>
                  <span>{i.name}</span>
                  <button className="link" onClick={() => putBack(i)}>
                    Put back
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="muted hint">
          <span className="badge weekly">Weekly</span> and <span className="badge scheduled">Every 2 weeks</span> are things you buy like
          clockwork. <span className="badge unsure">Not sure</span> means you buy it unevenly or now and then, so check. Removing something only
          takes it off this shop.
        </p>
      </section>
    </>
  );
}
