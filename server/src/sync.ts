import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HOUSEHOLD_LIST, nameKey, type DB } from "./db.js";
import { snooze } from "./planning.js";

// Ops are what phones queue while offline and replay on sync. Every op carries the client
// timestamp it was made at; the server keeps the newest write per row (last write wins).
// The server decides who made each op from the token, and drops ops on lists the person can't see.
const ItemSchema = z.object({
  id: z.string().min(1).max(64),
  listId: z.string().min(1).max(64).default(HOUSEHOLD_LIST),
  name: z.string().min(1).max(200),
  brand: z.string().max(100).nullish(),
  size: z.string().max(50).nullish(),
  qty: z.number().int().min(1).max(999).default(1),
  sectionId: z.string().min(1).max(64),
  done: z.boolean().default(false),
  source: z.enum(["text", "scan", "photo", "plan"]).default("text"),
  barcode: z.string().max(32).nullish(),
});

const ListSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  private: z.boolean().default(false),
});

export const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item.upsert"), at: z.number(), item: ItemSchema }),
  z.object({ type: z.literal("item.delete"), at: z.number(), id: z.string() }),
  z.object({ type: z.literal("items.clearDone"), at: z.number(), listId: z.string().default(HOUSEHOLD_LIST) }),
  z.object({ type: z.literal("sections.reorder"), at: z.number(), order: z.array(z.string()).max(100) }),
  z.object({ type: z.literal("list.upsert"), at: z.number(), list: ListSchema }),
  z.object({ type: z.literal("list.delete"), at: z.number(), id: z.string() }),
]);

export type Op = z.infer<typeof OpSchema>;

/** Trips with no activity for this long are closed automatically. */
export const TRIP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

interface ListRow {
  id: string;
  name: string;
  owner_id: string | null;
  private: number;
  updated_at: number;
  deleted: number;
}

function canSee(list: ListRow | undefined, userId: string): list is ListRow {
  return Boolean(list && !list.deleted && (!list.private || list.owner_id === userId));
}

export function activeTripId(db: DB, userId: string, listId: string): string | null {
  const row = db
    .prepare("SELECT id FROM trips WHERE user_id = ? AND list_id = ? AND ended_at IS NULL AND started_at > ?")
    .get(userId, listId, Date.now() - TRIP_TIMEOUT_MS) as { id: string } | undefined;
  return row?.id ?? null;
}

export function applyOps(db: DB, userId: string, ops: Op[]): void {
  const getList = db.prepare("SELECT * FROM lists WHERE id = ?");
  const getItem = db.prepare("SELECT list_id, done, updated_at FROM items WHERE id = ?");
  const getPlanned = db.prepare("SELECT name, source, done FROM items WHERE id = ?");
  const upsertItem = db.prepare(`
    INSERT INTO items (id, list_id, name, brand, size, qty, section_id, done, source, barcode, added_by_user, created_at, updated_at, deleted)
    VALUES (@id, @listId, @name, @brand, @size, @qty, @sectionId, @done, @source, @barcode, @userId, @at, @at, 0)
    ON CONFLICT(id) DO UPDATE SET
      list_id = excluded.list_id, name = excluded.name, brand = excluded.brand, size = excluded.size, qty = excluded.qty,
      section_id = excluded.section_id, done = excluded.done, source = excluded.source,
      barcode = excluded.barcode, updated_at = excluded.updated_at, deleted = 0
  `);
  const deleteItem = db.prepare("UPDATE items SET deleted = 1, updated_at = ? WHERE id = ? AND updated_at <= ?");
  const clearDone = db.prepare(
    "UPDATE items SET deleted = 1, updated_at = ? WHERE list_id = ? AND done = 1 AND deleted = 0 AND updated_at <= ?",
  );
  const setPos = db.prepare("UPDATE sections SET position = ? WHERE id = ?");
  const allSectionIds = db.prepare("SELECT id FROM sections ORDER BY position, id");
  const insertPurchase = db.prepare(`
    INSERT INTO purchases (item_id, user_id, list_id, trip_id, name, name_key, brand, size, qty, section_id, barcode, bought_at)
    VALUES (@id, @userId, @listId, @tripId, @name, @key, @brand, @size, @qty, @sectionId, @barcode, @at)
  `);
  // Unticking soon after ticking means "oops", not "returned it": forget that purchase.
  const undoPurchase = db.prepare("DELETE FROM purchases WHERE item_id = ? AND bought_at > ?");
  const upsertList = db.prepare(`
    INSERT INTO lists (id, name, owner_id, private, created_at, updated_at) VALUES (@id, @name, @owner, @private, @at, @at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, private = excluded.private, updated_at = excluded.updated_at, deleted = 0
  `);
  const deleteList = db.prepare("UPDATE lists SET deleted = 1, updated_at = ? WHERE id = ?");
  const deleteListItems = db.prepare("UPDATE items SET deleted = 1, updated_at = ? WHERE list_id = ? AND deleted = 0");

  const run = db.transaction((list: Op[]) => {
    for (const op of list) {
      switch (op.type) {
        case "item.upsert": {
          const it = op.item;
          if (!canSee(getList.get(it.listId) as ListRow | undefined, userId)) break;
          const row = getItem.get(it.id) as { list_id: string; done: number; updated_at: number } | undefined;
          if (row && !canSee(getList.get(row.list_id) as ListRow | undefined, userId)) break;
          if (row && row.updated_at > op.at) break;
          const fields = {
            id: it.id, listId: it.listId, name: it.name, brand: it.brand ?? null, size: it.size ?? null, qty: it.qty,
            sectionId: it.sectionId, done: it.done ? 1 : 0, source: it.source, barcode: it.barcode ?? null, userId, at: op.at,
          };
          upsertItem.run(fields);
          const wasDone = row?.done === 1;
          if (it.done && !wasDone) {
            insertPurchase.run({ ...fields, key: nameKey(it.name), tripId: activeTripId(db, userId, it.listId) });
          } else if (!it.done && wasDone) {
            undoPurchase.run(it.id, op.at - TRIP_TIMEOUT_MS);
          }
          break;
        }
        case "item.delete": {
          const row = getItem.get(op.id) as { list_id: string } | undefined;
          if (!row || !canSee(getList.get(row.list_id) as ListRow | undefined, userId)) break;
          const removed = deleteItem.run(op.at, op.id, op.at).changes > 0;
          // Removing something the weekly plan added, before buying it, means "not this week".
          const it = getPlanned.get(op.id) as { name: string; source: string; done: number } | undefined;
          if (removed && it?.source === "plan" && !it.done) snooze(db, row.list_id, it.name, 7, op.at);
          break;
        }
        case "items.clearDone":
          if (canSee(getList.get(op.listId) as ListRow | undefined, userId)) clearDone.run(op.at, op.listId, op.at);
          break;
        case "sections.reorder": {
          // Aisle order is household-wide: it describes the shop, not a list.
          const current = (allSectionIds.all() as Array<{ id: string }>).map((r) => r.id);
          const named = op.order.filter((id) => current.includes(id));
          const full = [...new Set(named), ...current.filter((id) => !named.includes(id))];
          full.forEach((id, i) => setPos.run(i, id));
          break;
        }
        case "list.upsert": {
          const existing = getList.get(op.list.id) as ListRow | undefined;
          if (existing) {
            if (!canSee(existing, userId) || existing.updated_at > op.at) break;
            // Only the owner can change who sees a list; the household list always stays shared.
            const owner = existing.owner_id === userId;
            const priv = existing.id === HOUSEHOLD_LIST ? 0 : owner ? Number(op.list.private) : existing.private;
            upsertList.run({ id: existing.id, name: op.list.name, owner: existing.owner_id, private: priv, at: op.at });
          } else {
            upsertList.run({ id: op.list.id, name: op.list.name, owner: userId, private: Number(op.list.private), at: op.at });
          }
          break;
        }
        case "list.delete": {
          const existing = getList.get(op.id) as ListRow | undefined;
          if (!canSee(existing, userId) || existing.id === HOUSEHOLD_LIST) break;
          if (existing.private ? existing.owner_id !== userId : existing.owner_id !== userId && existing.owner_id !== null) break;
          deleteList.run(op.at, op.id);
          deleteListItems.run(op.at, op.id);
          break;
        }
      }
    }
  });
  run(ops);
}

export function visibleListIds(db: DB, userId: string): string[] {
  return (
    db.prepare("SELECT id FROM lists WHERE deleted = 0 AND (private = 0 OR owner_id = ?) ORDER BY created_at, id").all(userId) as Array<{ id: string }>
  ).map((r) => r.id);
}

export function getState(db: DB, userId: string) {
  const lists = (
    db
      .prepare(
        `SELECT l.id, l.name, l.private, l.owner_id AS ownerId FROM lists l
         WHERE l.deleted = 0 AND (l.private = 0 OR l.owner_id = ?) ORDER BY l.created_at, l.id`,
      )
      .all(userId) as Array<{ id: string; name: string; private: number; ownerId: string | null }>
  ).map((l) => ({ ...l, private: l.private === 1 }));

  const sections = db.prepare("SELECT id, name, color FROM sections ORDER BY position, id").all() as Array<{ id: string; name: string; color: string }>;

  const rows = db
    .prepare(
      `SELECT i.*, COALESCE(u.name, i.added_by) AS added_by_name FROM items i
       LEFT JOIN users u ON u.id = i.added_by_user
       JOIN lists l ON l.id = i.list_id
       WHERE i.deleted = 0 AND l.deleted = 0 AND (l.private = 0 OR l.owner_id = ?)
       ORDER BY i.created_at, i.id`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  const items = rows.map((r) => ({
    id: r.id as string,
    listId: r.list_id as string,
    name: r.name as string,
    brand: (r.brand as string | null) ?? null,
    size: (r.size as string | null) ?? null,
    qty: r.qty as number,
    sectionId: r.section_id as string,
    done: r.done === 1,
    source: r.source as "text" | "scan" | "photo" | "plan",
    barcode: (r.barcode as string | null) ?? null,
    addedBy: (r.added_by_name as string | null) ?? null,
    addedById: (r.added_by_user as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }));

  // Who's shopping right now, so the other phone can say "Alex is shopping".
  const activeTrips = (
    db
      .prepare(
        `SELECT t.id, t.list_id AS listId, t.user_id AS userId, u.name, t.started_at AS startedAt,
                (SELECT COUNT(*) FROM purchases p WHERE p.trip_id = t.id) AS ticked
         FROM trips t JOIN users u ON u.id = t.user_id
         WHERE t.ended_at IS NULL AND t.started_at > ?`,
      )
      .all(Date.now() - TRIP_TIMEOUT_MS) as Array<{ id: string; listId: string; userId: string; name: string; startedAt: number; ticked: number }>
  ).filter((t) => lists.some((l) => l.id === t.listId));

  return { lists, sections, items, activeTrips, serverTime: Date.now() };
}

export function startTrip(db: DB, userId: string, listId: string): { id: string; startedAt: number } {
  const now = Date.now();
  // One trip at a time per person per list.
  db.prepare("UPDATE trips SET ended_at = ? WHERE user_id = ? AND list_id = ? AND ended_at IS NULL").run(now, userId, listId);
  const id = randomUUID();
  db.prepare("INSERT INTO trips (id, user_id, list_id, started_at) VALUES (?, ?, ?, ?)").run(id, userId, listId, now);
  return { id, startedAt: now };
}

export function finishTrip(db: DB, userId: string, tripId: string) {
  const trip = db.prepare("SELECT * FROM trips WHERE id = ? AND user_id = ?").get(tripId, userId) as
    | { id: string; list_id: string; started_at: number; ended_at: number | null }
    | undefined;
  if (!trip) return null;
  const endedAt = trip.ended_at ?? Date.now();
  db.prepare("UPDATE trips SET ended_at = ? WHERE id = ?").run(endedAt, tripId);
  const items = db.prepare("SELECT name, brand, size, qty FROM purchases WHERE trip_id = ? ORDER BY bought_at").all(tripId);
  return { id: trip.id, listId: trip.list_id, startedAt: trip.started_at, endedAt, items };
}

export function tripHistory(db: DB, userId: string, listId: string, limit = 20) {
  const trips = db
    .prepare(
      `SELECT t.id, t.started_at AS startedAt, t.ended_at AS endedAt, u.name AS shopper,
              (SELECT COUNT(*) FROM purchases p WHERE p.trip_id = t.id) AS count
       FROM trips t JOIN users u ON u.id = t.user_id
       WHERE t.list_id = ? ORDER BY t.started_at DESC LIMIT ?`,
    )
    .all(listId, limit) as Array<{ id: string; startedAt: number; endedAt: number | null; shopper: string; count: number }>;
  const items = db.prepare("SELECT name, brand, size, qty FROM purchases WHERE trip_id = ? ORDER BY bought_at");
  return trips.filter((t) => t.count > 0).map((t) => ({ ...t, items: items.all(t.id) }));
}
