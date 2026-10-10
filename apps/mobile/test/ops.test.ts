import { describe, expect, it } from "vitest";
import { applyOp, applyOps, DEFAULT_SECTIONS, groupItems, itemDetail, type ItemPayload, type ListState } from "../src/lib/ops";

const empty: ListState = { sections: DEFAULT_SECTIONS, items: [] };
const item = (over: Partial<ItemPayload> = {}): ItemPayload => ({
  id: "a", name: "Milk", brand: null, size: null, qty: 1, sectionId: "dairy",
  done: false, source: "text", barcode: null, addedBy: "Sam", ...over,
});

describe("applyOp", () => {
  it("adds then updates an item, keeping createdAt", () => {
    let st = applyOp(empty, { type: "item.upsert", at: 1, item: item() });
    st = applyOp(st, { type: "item.upsert", at: 5, item: item({ done: true }) });
    expect(st.items).toHaveLength(1);
    expect(st.items[0]).toMatchObject({ done: true, createdAt: 1, updatedAt: 5 });
  });

  it("ignores older writes", () => {
    const st = applyOps(empty, [
      { type: "item.upsert", at: 5, item: item({ qty: 3 }) },
      { type: "item.upsert", at: 2, item: item({ qty: 1 }) },
    ]);
    expect(st.items[0].qty).toBe(3);
  });

  it("clears only ticked items", () => {
    const st = applyOps(empty, [
      { type: "item.upsert", at: 1, item: item({ id: "a", done: true }) },
      { type: "item.upsert", at: 1, item: item({ id: "b" }) },
      { type: "items.clearDone", at: 2 },
    ]);
    expect(st.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("reorders sections, keeping unnamed ones after", () => {
    const st = applyOp(empty, { type: "sections.reorder", at: 1, order: ["frozen", "nope", "produce"] });
    expect(st.sections.slice(0, 3).map((s) => s.id)).toEqual(["frozen", "produce", "bakery"]);
    expect(st.sections).toHaveLength(DEFAULT_SECTIONS.length);
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
    const groups = groupItems(st);
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
