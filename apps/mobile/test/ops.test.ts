import { describe, expect, it } from "vitest";
import { applyOp, applyOps, DEFAULT_LISTS, DEFAULT_SECTIONS, groupItems, itemDetail, type ItemPayload, type ListState } from "../src/lib/ops";

const empty: ListState = { lists: DEFAULT_LISTS, sections: DEFAULT_SECTIONS, items: [] };
const me = { id: "u1", name: "Sam" };
const item = (over: Partial<ItemPayload> = {}): ItemPayload => ({
  id: "a", listId: "household", name: "Milk", brand: null, size: null, qty: 1, sectionId: "dairy",
  done: false, source: "text", barcode: null, ...over,
});

describe("applyOp", () => {
  it("adds then updates an item, keeping createdAt and who added it", () => {
    let st = applyOp(empty, { type: "item.upsert", at: 1, item: item() }, me);
    st = applyOp(st, { type: "item.upsert", at: 5, item: item({ done: true }) }, { id: "u2", name: "Alex" });
    expect(st.items).toHaveLength(1);
    expect(st.items[0]).toMatchObject({ done: true, createdAt: 1, updatedAt: 5, addedBy: "Sam", addedById: "u1" });
  });

  it("ignores older writes", () => {
    const st = applyOps(empty, [
      { type: "item.upsert", at: 5, item: item({ qty: 3 }) },
      { type: "item.upsert", at: 2, item: item({ qty: 1 }) },
    ]);
    expect(st.items[0].qty).toBe(3);
  });

  it("clears ticked items on one list only", () => {
    const st = applyOps(empty, [
      { type: "item.upsert", at: 1, item: item({ id: "a", done: true }) },
      { type: "item.upsert", at: 1, item: item({ id: "b" }) },
      { type: "item.upsert", at: 1, item: item({ id: "c", listId: "gifts", done: true }) },
      { type: "items.clearDone", at: 2, listId: "household" },
    ]);
    expect(st.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("reorders sections, keeping unnamed ones after", () => {
    const st = applyOp(empty, { type: "sections.reorder", at: 1, order: ["frozen", "nope", "produce"] });
    expect(st.sections.slice(0, 3).map((s) => s.id)).toEqual(["frozen", "produce", "bakery"]);
    expect(st.sections).toHaveLength(DEFAULT_SECTIONS.length);
  });

  it("creates, renames and deletes lists, but never the household list", () => {
    let st = applyOp(empty, { type: "list.upsert", at: 1, list: { id: "gifts", name: "Gifts", private: true } }, me);
    expect(st.lists[1]).toEqual({ id: "gifts", name: "Gifts", private: true, ownerId: "u1" });
    st = applyOps(st, [
      { type: "item.upsert", at: 2, item: item({ id: "g", listId: "gifts" }) },
      { type: "list.upsert", at: 3, list: { id: "household", name: "Groceries", private: true } },
      { type: "list.delete", at: 4, id: "gifts" },
      { type: "list.delete", at: 4, id: "household" },
    ]);
    expect(st.lists).toEqual([{ id: "household", name: "Groceries", private: false, ownerId: null }]);
    expect(st.items).toHaveLength(0);
  });
});

describe("groupItems", () => {
  it("groups in aisle order, hides empty sections, puts unknown sections in Other, ticked last", () => {
    const st = applyOps(empty, [
      { type: "item.upsert", at: 1, item: item({ id: "milk", sectionId: "dairy", done: true }) },
      { type: "item.upsert", at: 2, item: item({ id: "eggs", sectionId: "dairy" }) },
      { type: "item.upsert", at: 3, item: item({ id: "bread", sectionId: "bakery" }) },
      { type: "item.upsert", at: 4, item: item({ id: "x", sectionId: "deleted-section" }) },
    ]);
    const groups = groupItems(st.sections, st.items);
    expect(groups.map((g) => g.section.id)).toEqual(["bakery", "dairy", "other"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["eggs", "milk"]);
    expect(groups[1].left).toBe(1);
  });
});

describe("itemDetail", () => {
  it("joins quantity, brand and size", () => {
    expect(itemDetail({ qty: 2, brand: "Avonmore", size: "2 L" })).toBe("×2 · Avonmore · 2 L");
    expect(itemDetail({ qty: 1, brand: null, size: null })).toBe("");
  });
});
