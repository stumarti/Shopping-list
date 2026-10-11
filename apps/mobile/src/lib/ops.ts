// Mirrors server/src/sync.ts. Changes are applied locally straight away and queued as ops;
// the server is the source of truth, keeps the newest write per item and decides who can see what.

export type Source = "text" | "scan" | "photo" | "plan";

export const HOUSEHOLD_LIST = "household";

export interface Section {
  id: string;
  name: string;
  color: string;
}

export interface List {
  id: string;
  name: string;
  private: boolean;
  ownerId: string | null;
}

export interface Item {
  id: string;
  listId: string;
  name: string;
  brand: string | null;
  size: string | null;
  qty: number;
  sectionId: string;
  done: boolean;
  source: Source;
  barcode: string | null;
  addedBy: string | null;
  addedById: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What the phone sends; the server fills in who added it. */
export type ItemPayload = Omit<Item, "createdAt" | "updatedAt" | "addedBy" | "addedById">;

export type Op =
  | { type: "item.upsert"; at: number; item: ItemPayload }
  | { type: "item.delete"; at: number; id: string }
  | { type: "items.clearDone"; at: number; listId: string }
  | { type: "sections.reorder"; at: number; order: string[] }
  | { type: "list.upsert"; at: number; list: { id: string; name: string; private: boolean } }
  | { type: "list.delete"; at: number; id: string };

export interface ListState {
  lists: List[];
  sections: Section[];
  items: Item[];
}

export interface Author {
  id: string | null;
  name: string | null;
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

export const DEFAULT_LISTS: List[] = [{ id: HOUSEHOLD_LIST, name: "Shopping", private: false, ownerId: null }];

/** `me` is used to attribute optimistic changes until the server's version arrives. */
export function applyOp(state: ListState, op: Op, me: Author = { id: null, name: null }): ListState {
  switch (op.type) {
    case "item.upsert": {
      const existing = state.items.find((i) => i.id === op.item.id);
      if (existing && existing.updatedAt > op.at) return state;
      const next: Item = {
        ...op.item,
        addedBy: existing?.addedBy ?? me.name,
        addedById: existing?.addedById ?? me.id,
        createdAt: existing?.createdAt ?? op.at,
        updatedAt: op.at,
      };
      return {
        ...state,
        items: existing ? state.items.map((i) => (i.id === next.id ? next : i)) : [...state.items, next],
      };
    }
    case "item.delete":
      return { ...state, items: state.items.filter((i) => !(i.id === op.id && i.updatedAt <= op.at)) };
    case "items.clearDone":
      return { ...state, items: state.items.filter((i) => !(i.listId === op.listId && i.done && i.updatedAt <= op.at)) };
    case "sections.reorder": {
      const byId = new Map(state.sections.map((s) => [s.id, s]));
      const named = [...new Set(op.order.filter((id) => byId.has(id)))];
      const rest = state.sections.filter((s) => !named.includes(s.id));
      return { ...state, sections: [...named.map((id) => byId.get(id)!), ...rest] };
    }
    case "list.upsert": {
      const existing = state.lists.find((l) => l.id === op.list.id);
      if (existing) {
        const priv = existing.id === HOUSEHOLD_LIST ? false : op.list.private;
        return { ...state, lists: state.lists.map((l) => (l.id === existing.id ? { ...l, name: op.list.name, private: priv } : l)) };
      }
      return { ...state, lists: [...state.lists, { ...op.list, ownerId: me.id }] };
    }
    case "list.delete":
      if (op.id === HOUSEHOLD_LIST) return state;
      return { ...state, lists: state.lists.filter((l) => l.id !== op.id), items: state.items.filter((i) => i.listId !== op.id) };
  }
}

export function applyOps(state: ListState, ops: Op[], me?: Author): ListState {
  return ops.reduce((s, op) => applyOp(s, op, me), state);
}

export interface Group {
  section: Section;
  items: Item[];
  left: number;
}

/** Items grouped in aisle order; sections with no items are hidden, unknown sections fall into "Other". */
export function groupItems(sections: Section[], items: Item[]): Group[] {
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
