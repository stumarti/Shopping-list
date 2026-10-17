import { useEffect, useState } from "react";
import { api, type History, type Suggestion } from "./api";

type Props = {
  onList: { has: (name: string) => boolean };
  listSize: number;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
};

const GROUPS: { key: keyof History["suggestions"]; title: string; empty?: string }[] = [
  { key: "will", title: "You will want" },
  { key: "might", title: "You might want" },
  { key: "extras", title: "Extras" },
];

/** Suggestions from your past shopping: what's due, what's coming up, and the things you buy now and then. */
export default function Suggestions({ onList, listSize, run }: Props) {
  const [groups, setGroups] = useState<History["suggestions"] | null>(null);

  useEffect(() => {
    api.history().then((h) => setGroups(h.suggestions), () => setGroups(null));
  }, [listSize]);

  if (!groups || !GROUPS.some((g) => groups[g.key].length)) return null;
  const notOnList = (items: Suggestion[]) => items.filter((i) => !onList.has(i.name.toLowerCase()));
  const willToAdd = notOnList(groups.will);

  const addAll = () =>
    run(async () => {
      for (const i of willToAdd) await api.add(i.name, i.category, i.qty);
    });

  return (
    <section aria-labelledby="suggest-heading" className="suggest">
      <div className="section-head">
        <h2 id="suggest-heading">From your past shopping</h2>
        {willToAdd.length > 1 && (
          <button className="link" onClick={addAll}>
            Add all {willToAdd.length}
          </button>
        )}
      </div>
      {GROUPS.map(({ key, title }) =>
        groups[key].length ? (
          <div key={key} className="group">
            <h3>{title}</h3>
            <ul className="suggest-list">
              {groups[key].map((i) => {
                const already = onList.has(i.name.toLowerCase());
                return (
                  <li key={i.catalog_id}>
                    <span>
                      {i.name}
                      {i.qty > 1 && <span className="muted"> ×{i.qty}</span>}
                      <span className="muted reason">{i.reason}</span>
                    </span>
                    <button className="link" disabled={already} onClick={() => run(() => api.add(i.name, i.category, i.qty))}>
                      {already ? "On the list" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}
