import { z } from "zod";
import type { DB } from "./db.js";

// Ops are what phones queue while offline and replay on sync. Every op carries the client
// timestamp it was made at; the server keeps the newest write per row (last write wins).
const ItemSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  brand: z.string().max(100).nullish(),
  size: z.string().max(50).nullish(),
  qty: z.number().int().min(1).max(999).default(1),
  sectionId: z.string().min(1).max(64),
  done: z.boolean().default(false),
  source: z.enum(["text", "scan", "photo"]).default("text"),
  barcode: z.string().max(32).nullish(),
  addedBy: z.string().max(40).nullish(),
});

const SectionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item.upsert"), at: z.number(), item: ItemSchema }),
  z.object({ type: z.literal("item.delete"), at: z.number(), id: z.string() }),
  z.object({ type: z.literal("items.clearDone"), at: z.number() }),
  z.object({ type: z.literal("section.upsert"), at: z.number(), section: SectionSchema }),
  z.object({ type: z.literal("sections.reorder"), at: z.number(), order: z.array(z.string()).max(100) }),
]);

export type Op = z.infer<typeof OpSchema>;
export type Item = z.infer<typeof ItemSchema>;

export interface State {
  sections: Array<{ id: string; name: string; color: string }>;
  items: Array<Item & { createdAt: number; updatedAt: number }>;
  serverTime: number;
}

export function applyOps(db: DB, ops: Op[]): void {
  const getItem = db.prepare("SELECT updated_at FROM items WHERE id = ?");
  const upsertItem = db.prepare(`
    INSERT INTO items (id, name, brand, size, qty, section_id, done, source, barcode, added_by, created_at, updated_at, deleted)
    VALUES (@id, @name, @brand, @size, @qty, @sectionId, @done, @source, @barcode, @addedBy, @at, @at, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, brand = excluded.brand, size = excluded.size, qty = excluded.qty,
      section_id = excluded.section_id, done = excluded.done, source = excluded.source,
      barcode = excluded.barcode, updated_at = excluded.updated_at, deleted = 0
  `);
  const deleteItem = db.prepare("UPDATE items SET deleted = 1, updated_at = ? WHERE id = ? AND updated_at <= ?");
  const clearDone = db.prepare("UPDATE items SET deleted = 1, updated_at = ? WHERE done = 1 AND deleted = 0 AND updated_at <= ?");
  const getSection = db.prepare("SELECT updated_at FROM sections WHERE id = ?");
  const maxPos = db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM sections");
  const upsertSection = db.prepare(`
    INSERT INTO sections (id, name, color, position, updated_at) VALUES (@id, @name, @color, @position, @at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, updated_at = excluded.updated_at
  `);
  const setPos = db.prepare("UPDATE sections SET position = ? WHERE id = ?");
  const allSectionIds = db.prepare("SELECT id FROM sections ORDER BY position, id");

  const run = db.transaction((list: Op[]) => {
    for (const op of list) {
      switch (op.type) {
        case "item.upsert": {
          const row = getItem.get(op.item.id) as { updated_at: number } | undefined;
          if (row && row.updated_at > op.at) break;
          const it = op.item;
          upsertItem.run({
            id: it.id, name: it.name, brand: it.brand ?? null, size: it.size ?? null, qty: it.qty,
            sectionId: it.sectionId, done: it.done ? 1 : 0, source: it.source, barcode: it.barcode ?? null,
            addedBy: it.addedBy ?? null, at: op.at,
          });
          break;
        }
        case "item.delete":
          deleteItem.run(op.at, op.id, op.at);
          break;
        case "items.clearDone":
          clearDone.run(op.at, op.at);
          break;
        case "section.upsert": {
          const row = getSection.get(op.section.id) as { updated_at: number } | undefined;
          if (row && row.updated_at > op.at) break;
          const position = (maxPos.get() as { p: number }).p + 1;
          upsertSection.run({ ...op.section, position, at: op.at });
          break;
        }
        case "sections.reorder": {
          // Sections not named keep their relative order after the named ones.
          const current = (allSectionIds.all() as Array<{ id: string }>).map((r) => r.id);
          const named = op.order.filter((id) => current.includes(id));
          const full = [...new Set(named), ...current.filter((id) => !named.includes(id))];
          full.forEach((id, i) => setPos.run(i, id));
          break;
        }
      }
    }
  });
  run(ops);
}

export function getState(db: DB): State {
  const sections = db.prepare("SELECT id, name, color FROM sections ORDER BY position, id").all() as State["sections"];
  const rows = db
    .prepare("SELECT * FROM items WHERE deleted = 0 ORDER BY created_at, id")
    .all() as Array<Record<string, unknown>>;
  const items = rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    brand: (r.brand as string | null) ?? null,
    size: (r.size as string | null) ?? null,
    qty: r.qty as number,
    sectionId: r.section_id as string,
    done: r.done === 1,
    source: r.source as Item["source"],
    barcode: (r.barcode as string | null) ?? null,
    addedBy: (r.added_by as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }));
  return { sections, items, serverTime: Date.now() };
}
