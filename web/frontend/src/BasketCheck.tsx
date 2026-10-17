import { Fragment, useEffect, useState } from "react";
import { api, fillLink, type BasketCheck, type Forgotten, type Links, type NextShop, type ShopItem } from "./api";
import Icon from "./Icon";

type Store = Links["stores"][number];
type Run = (action: () => Promise<unknown>) => Promise<boolean>;
const DISMISSED_KEY = "shopping-list.not-this-time";

/** Things you said "not this time" to, for this shop's date only. */
function useDismissed(shopDate: string): [Set<string>, (key: string) => void] {
  const read = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "null");
      return new Set<string>(saved?.date === shopDate ? saved.keys : []);
    } catch {
      return new Set<string>();
    }
  };
  const [keys, setKeys] = useState(read);
  useEffect(() => setKeys(read()), [shopDate]);
  const dismiss = (key: string) => {
    const next = new Set(keys).add(key);
    setKeys(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify({ date: shopDate, keys: [...next] }));
    } catch {
      // Not remembered on this device.
    }
  };
  return [keys, dismiss];
}

type Check = { key: string; name: string; why: string; kind: "pick" | "maybe" | "regular" | "due"; qty: number; category: string; set?: ShopItem };

/**
 * Before you order: what might be missing from this shop. Pick-one sets not picked yet, maybes not decided,
 * regulars that aren't on it, and things due before the shop after. Add it, or say not this time.
 */
export function BeforeYouOrder({ plan, refresh, run }: { plan: NextShop; refresh: () => void; run: Run }) {
  const [forgotten, setForgotten] = useState<Forgotten>({ regulars: [], due_soon: [] });
  const [dismissed, dismiss] = useDismissed(plan.shop?.date ?? "anytime");
  useEffect(() => {
    api.forgotten().then(setForgotten, () => setForgotten({ regulars: [], due_soon: [] }));
  }, [plan]);

  const checks: Check[] = [
    ...plan.items
      .filter((i) => i.kind === "or" && i.chosen === null)
      .map((i) => ({ key: `pick:${i.catalog_id}`, name: i.name, why: "Pick one for this shop", kind: "pick" as const, qty: i.qty, category: i.category, set: i })),
    ...plan.maybe.map((i) => ({ key: `maybe:${i.catalog_id}`, name: i.name, why: `Not sure: ${i.detail.toLowerCase()}`, kind: "maybe" as const, qty: i.qty, category: i.category })),
    ...forgotten.regulars.map((i) => ({ key: `regular:${i.catalog_id}`, name: i.name, why: i.reason, kind: "regular" as const, qty: i.qty, category: i.category })),
    ...forgotten.due_soon.map((i) => ({ key: `due:${i.catalog_id}`, name: i.name, why: `${i.reason}, before the shop after`, kind: "due" as const, qty: i.qty, category: i.category })),
  ].filter((c) => !dismissed.has(c.key));

  const add = (c: Check) =>
    run(async () => {
      await api.add(c.name, c.category, c.qty);
      refresh();
    });
  const choose = (set: ShopItem, optionId: number) =>
    run(async () => {
      await api.chooseForShop(set.catalog_id!, optionId);
      refresh();
    });

  return (
    <div className={`before-order${checks.length ? "" : " clear"}`}>
      <h3 className="part-title">
        <Icon name="check" size={16} /> Before you order
      </h3>
      {checks.length === 0 ? (
        <p className="all-clear">
          <Icon name="checked" size={18} /> Nothing obvious missing: everything you usually get is on the list.
        </p>
      ) : (
        <>
          <p className="muted part-note">
            {checks.length} {checks.length === 1 ? "thing" : "things"} to check so nothing's missed.
          </p>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.key}>
                <div className="check-main">
                  <span className="check-name">{c.name}</span>
                  <span className="muted check-why">{c.why}</span>
                  {c.set && (
                    <span className="options" role="group" aria-label={`Pick one for ${c.name}`}>
                      {(c.set.options ?? []).map((o, n) => (
                        <Fragment key={o.catalog_id}>
                          {n > 0 && <span className="or">or</span>}
                          <button className="option" onClick={() => choose(c.set!, o.catalog_id)}>
                            {o.name}
                            {o.due && <span className="due-dot" aria-label="(due)" />}
                          </button>
                        </Fragment>
                      ))}
                    </span>
                  )}
                </div>
                <span className="check-actions">
                  {!c.set && (
                    <button className="add-one" onClick={() => add(c)} aria-label={`Add ${c.name}`}>
                      <Icon name="add" size={18} /> Add
                    </button>
                  )}
                  <button className="link" onClick={() => dismiss(c.key)}>
                    Not this time
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const STATUS = {
  added: { icon: "checked", label: "In basket" },
  swapped: { icon: "swap", label: "Swapped" },
  missing: { icon: "missing", label: "Missing" },
  unreported: { icon: "unknown", label: "Not mentioned" },
} as const;
export type BasketStatus = keyof typeof STATUS;

/** A small marker for an item on the list: what Claude said it did with it. */
export function StatusMark({ status }: { status: BasketStatus }) {
  const s = STATUS[status];
  return (
    <span className={`status-mark ${status}`}>
      <Icon name={s.icon} size={15} /> {s.label}
    </span>
  );
}

/**
 * After Claude fills the basket: paste its reply, and see what's in, what was swapped, what's missing and what it
 * didn't mention, so you can sort those out before you check out.
 */
export function CheckBasket({ store, check, setCheck, run }: { store: Store; check: BasketCheck; setCheck: (c: BasketCheck) => void; run: Run }) {
  const [text, setText] = useState("");
  const send = () =>
    run(async () => {
      setCheck(await api.checkBasket(store.id, text));
      setText("");
    });
  const fresh = () =>
    run(async () => {
      await api.clearBasketCheck(store.id);
      setCheck(null);
    });
  const keep = (id: number) => run(async () => setCheck(await api.keepSwap(id)));
  const find = (name: string) => fillLink(store.search, name);

  const missing = check?.items.filter((i) => i.status === "missing") ?? [];
  const swapped = check?.items.filter((i) => i.status === "swapped") ?? [];
  const added = check?.items.filter((i) => i.status === "added") ?? [];
  const toSort = missing.length + (check?.unreported.length ?? 0);

  return (
    <div className="check-basket">
      <div className="section-head prompt-head">
        <h3>Check the basket</h3>
        {check && (
          <button className="link" onClick={fresh}>
            New order
          </button>
        )}
      </div>

      {!check ? (
        <>
          <p className="muted part-note">When Claude's done, copy its whole reply and paste it here. It ends with a results block that this reads.</p>
          <textarea
            className="prompt paste-results"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste Claude's reply…"
            aria-label="Claude's reply"
          />
          <button className="primary" disabled={!text.trim()} onClick={send}>
            <Icon name="check" size={18} /> Check
          </button>
        </>
      ) : (
        <div className="review" aria-live="polite">
          <p className={`review-sum${toSort ? " todo" : ""}`}>
            {toSort === 0 ? <Icon name="checked" size={18} /> : <Icon name="missing" size={18} />}{" "}
            <strong>{toSort === 0 ? "Everything's accounted for." : `${toSort} to sort out before you check out.`}</strong>{" "}
            <span className="muted">
              {check.counts.added} in the basket · {check.counts.swapped} swapped · {check.counts.missing} missing
              {check.unreported.length > 0 && ` · ${check.unreported.length} not mentioned`}
              {check.total && ` · ${check.total}`}
            </span>
          </p>

          {missing.length > 0 && (
            <ReviewPart title="Missing" note="Nothing was added for these. Find them yourself, or something like them.">
              {missing.map((i) => (
                <li key={i.id}>
                  <span>
                    <StatusMark status="missing" /> {i.item}
                    {i.note && <span className="muted"> · {i.note}</span>}
                  </span>
                  <a href={find(i.item)} target="_blank" rel="noreferrer">
                    Find on {store.name}
                  </a>
                </li>
              ))}
            </ReviewPart>
          )}

          {check.unreported.length > 0 && (
            <ReviewPart title="Not mentioned" note="On your list, but Claude didn't say what it did. Check the basket for these.">
              {check.unreported.map((name) => (
                <li key={name}>
                  <span>
                    <StatusMark status="unreported" /> {name}
                  </span>
                  <a href={find(name)} target="_blank" rel="noreferrer">
                    Find on {store.name}
                  </a>
                </li>
              ))}
            </ReviewPart>
          )}

          {swapped.length > 0 && (
            <ReviewPart title="Swapped" note="Something else went in. Check you're happy with it; keep it to buy that from now on.">
              {swapped.map((i) => (
                <li key={i.id}>
                  <span>
                    <StatusMark status="swapped" /> {i.item} →{" "}
                    {i.url ? (
                      <a href={i.url} target="_blank" rel="noreferrer">
                        {i.product || "the swap"}
                      </a>
                    ) : (
                      i.product || "something else"
                    )}
                    {i.note && <span className="muted"> · {i.note}</span>}
                  </span>
                  {i.kept ? (
                    <span className="muted">Kept</span>
                  ) : (
                    i.url &&
                    i.catalog_id !== null && (
                      <button className="link" onClick={() => keep(i.id)}>
                        Keep from now on
                      </button>
                    )
                  )}
                </li>
              ))}
            </ReviewPart>
          )}

          {added.length > 0 && (
            <details className="review-part">
              <summary>
                <StatusMark status="added" /> In the basket ({added.length})
                {added.some((i) => i.link_saved) && (
                  <span className="muted">
                    {" "}
                    · {added.filter((i) => i.link_saved).length} product {added.filter((i) => i.link_saved).length === 1 ? "link" : "links"} saved
                  </span>
                )}
              </summary>
              <ul>
                {added.map((i) => (
                  <li key={i.id}>
                    <span>
                      {i.item}
                      {i.product && i.product.toLowerCase() !== i.item.toLowerCase() && <span className="muted"> · {i.product}</span>}
                      {i.qty !== null && i.qty !== 1 && <span className="muted"> ×{i.qty}</span>}
                    </span>
                    {i.link_saved && (
                      <span className="muted">
                        <Icon name="link" size={14} /> saved
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="muted hint">
            Checked {new Date(check.checked_at.replace(" ", "T") + "Z").toLocaleString("en-IE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}. Paste
            a newer reply after <em>New order</em>.
          </p>
        </div>
      )}
    </div>
  );
}

function ReviewPart({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="review-part">
      <h4>{title}</h4>
      <p className="muted part-note">{note}</p>
      <ul>{children}</ul>
    </div>
  );
}
