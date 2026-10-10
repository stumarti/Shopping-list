// Mirrors server/src/sync.ts. Changes are applied locally straight away and queued as ops;
// the server is the source of truth and keeps the newest write per item.

export type Source = "text" | "scan" | "photo";

export interface Section {
  id: string;
  name: string;
  color: string;
}

export interface Item {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  qty: number;
  sectionId: string;
  done: boolean;
  source: Source;
  barcode: string | null;
  addedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ItemPayload = Omit<Item, "createdAt" | "updatedAt">;

export type Op =
  | { type: "item.upsert"; at: number; item: ItemPayload }
  | { type: "item.delete"; at: number; id: string }
  | { type: "items.clearDone"; at: number }
  | { type: "sections.reorder"; at: number; order: string[] };

export interface ListState {
  sections: Section[];
  items: Item[];
}

export const DEFAULT_SECTIONS: Section[] = [
  { id: "produce", name: "Fruit & veg", color: "#3E8E41" },
  { id: "bakery", name: "Bakery", color: "#B7791F" },
  { id: "deli", name: "Deli", color: "#D07A5B" },
  { id: "meat", name: "Meat & fish", color: "#C2413B" },
  { id: "dairy", name: "Dairy & eggs", color: "#3B82C4" },
  { id: "cupboard", name: "Cupboard", color: "#A0703A" },
  { id: "drinks", name: "Drinks", color: "#2E9C8F" },
  { id: "frozen", name: "Frozen", color: "#4F97A8" },
  { id: "household", name: "Household", color: "#7A6BB0" },
  { id: "health", name: "Health & beauty", color: "#B05A8E" },
  { id: "other", name: "Other", color: "#8A918C" },
];

export function applyOp(state: ListState, op: Op): ListState {
  switch (op.type) {
    case "item.upsert": {
      const existing = state.items.find((i) => i.id === op.item.id);
      if (existing && existing.updatedAt > op.at) return state;
      const next: Item = { ...op.item, createdAt: existing?.createdAt ?? op.at, updatedAt: op.at };
      return {
        ...state,
        items: existing ? state.items.map((i) => (i.id === next.id ? next : i)) : [...state.items, next],
      };
    }
    case "item.delete":
      return { ...state, items: state.items.filter((i) => !(i.id === op.id && i.updatedAt <= op.at)) };
    case "items.clearDone":
      return { ...state, items: state.items.filter((i) => !(i.done && i.updatedAt <= op.at)) };
    case "sections.reorder": {
      const byId = new Map(state.sections.map((s) => [s.id, s]));
      const named = [...new Set(op.order.filter((id) => byId.has(id)))];
      const rest = state.sections.filter((s) => !named.includes(s.id));
      return { ...state, sections: [...named.map((id) => byId.get(id)!), ...rest] };
    }
  }
}

export function applyOps(state: ListState, ops: Op[]): ListState {
  return ops.reduce(applyOp, state);
}

export interface Group {
  section: Section;
  items: Item[];
  left: number;
}

/** Items grouped in aisle order; sections with no items are hidden, unknown sections fall into "Other". */
export function groupItems({ sections, items }: ListState): Group[] {
  const known = new Set(sections.map((s) => s.id));
  const fallback = sections.find((s) => s.id === "other") ?? DEFAULT_SECTIONS[DEFAULT_SECTIONS.length - 1];
  const all = known.has(fallback.id) ? sections : [...sections, fallback];
  return all
    .map((section) => {
      const list = items
        .filter((i) => (known.has(i.sectionId) ? i.sectionId : fallback.id) === section.id)
        .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt);
      return { section, items: list, left: list.filter((i) => !i.done).length };
    })
    .filter((g) => g.items.length > 0);
}

export function itemDetail(item: Pick<Item, "brand" | "size" | "qty">): string {
  return [item.qty > 1 ? `×${item.qty}` : null, item.brand, item.size].filter(Boolean).join(" · ");
}
