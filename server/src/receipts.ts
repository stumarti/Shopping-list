import { randomUUID } from "node:crypto";
import type { Assistant, ReceiptDraft, ReceiptFile } from "./ai/index.js";
import { nameKey, type DB } from "./db.js";
import type { Section } from "./sections.js";

// Receipts become purchase history: each product line is a purchase on the receipt's date, with its
// price. New receipts wait for you to check them; a folder of old receipts can be imported in bulk.

export interface ReceiptLineRow {
  idx: number;
  raw: string;
  name: string;
  brand: string | null;
  size: string | null;
  qty: number;
  unitPrice: number | null;
  lineTotal: number | null;
  sectionId: string;
  isProduct: boolean;
}

export interface Receipt {
  id: string;
  listId: string;
  store: string | null;
  purchasedOn: string | null;
  total: number | null;
  status: "review" | "confirmed" | "failed";
  source: "app" | "inbox";
  fileName: string | null;
  error: string | null;
  createdAt: number;
  lines: ReceiptLineRow[];
}

export class DuplicateReceiptError extends Error {
  constructor(public existingId: string) {
    super("This receipt has already been added.");
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fingerprint(d: { store: string | null; date: string | null; total: number | null }): string | null {
  if (!d.store || !d.date || d.total == null) return null;
  return `${d.store.toLowerCase().replace(/[^a-z]/g, "")}|${d.date}|${d.total.toFixed(2)}`;
}

/** Names this household already uses, so receipt lines line up with list items. */
export function knownNames(db: DB, listId: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM (SELECT name, MAX(bought_at) AS t FROM purchases WHERE list_id = ? GROUP BY name_key
         UNION SELECT name, MAX(updated_at) AS t FROM items WHERE list_id = ? AND deleted = 0 GROUP BY lower(name))
         ORDER BY t DESC LIMIT 300`,
      )
      .all(listId, listId) as Array<{ name: string }>
  ).map((r) => r.name);
}

export function getReceipt(db: DB, id: string): Receipt | null {
  const r = db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
  if (!r) return null;
  const lines = (db.prepare("SELECT * FROM receipt_lines WHERE receipt_id = ? ORDER BY idx").all(id) as Array<Record<string, string | number | null>>).map(
    (l): ReceiptLineRow => ({
      idx: l.idx as number,
      raw: l.raw as string,
      name: l.name as string,
      brand: l.brand as string | null,
      size: l.size as string | null,
      qty: l.qty as number,
      unitPrice: l.unit_price as number | null,
      lineTotal: l.line_total as number | null,
      sectionId: l.section_id as string,
      isProduct: l.is_product === 1,
    }),
  );
  return {
    id: r.id as string,
    listId: r.list_id as string,
    store: r.store as string | null,
    purchasedOn: r.purchased_on as string | null,
    total: r.total as number | null,
    status: r.status as Receipt["status"],
    source: r.source as Receipt["source"],
    fileName: r.file_name as string | null,
    error: r.error as string | null,
    createdAt: r.created_at as number,
    lines,
  };
}

export function listReceipts(db: DB, listId: string, limit = 100) {
  return db
    .prepare(
      `SELECT r.id, r.store, r.purchased_on AS purchasedOn, r.total, r.status, r.source, r.file_name AS fileName, r.error, r.created_at AS createdAt,
              (SELECT COUNT(*) FROM receipt_lines l WHERE l.receipt_id = r.id AND l.is_product = 1) AS items
       FROM receipts r WHERE r.list_id = ? ORDER BY COALESCE(r.purchased_on, '') DESC, r.created_at DESC LIMIT ?`,
    )
    .all(listId, limit);
}

function saveDraft(db: DB, id: string, draft: ReceiptDraft) {
  db.transaction(() => {
    db.prepare("UPDATE receipts SET store = ?, purchased_on = ?, total = ?, fingerprint = ? WHERE id = ?").run(
      draft.store,
      draft.date && DATE.test(draft.date) ? draft.date : null,
      draft.total,
      fingerprint(draft),
      id,
    );
    db.prepare("DELETE FROM receipt_lines WHERE receipt_id = ?").run(id);
    const add = db.prepare(
      "INSERT INTO receipt_lines (receipt_id, idx, raw, name, brand, size, qty, unit_price, line_total, section_id, is_product) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    draft.lines.forEach((l, i) =>
      add.run(id, i, l.raw, l.name.trim() || l.raw, l.brand, l.size, Math.max(1, Math.min(99, Math.round(l.qty || 1))), l.unitPrice, l.lineTotal, l.sectionId, l.isProduct ? 1 : 0),
    );
  })();
}

/** Read a receipt with the AI and keep it for review. Throws DuplicateReceiptError for one already confirmed. */
export async function readReceipt(
  deps: { db: DB; assistant: Assistant; sections: Section[] },
  userId: string,
  listId: string,
  files: ReceiptFile[],
  meta: { source: Receipt["source"]; fileName?: string } = { source: "app" },
): Promise<Receipt> {
  const { db, assistant, sections } = deps;
  const draft = await assistant.readReceipt(files, sections, knownNames(db, listId));
  const fp = fingerprint(draft);
  if (fp) {
    const dup = db.prepare("SELECT id FROM receipts WHERE list_id = ? AND fingerprint = ? AND status = 'confirmed'").get(listId, fp) as { id: string } | undefined;
    if (dup) throw new DuplicateReceiptError(dup.id);
  }
  const id = randomUUID();
  db.prepare("INSERT INTO receipts (id, user_id, list_id, status, source, file_name, created_at) VALUES (?, ?, ?, 'review', ?, ?, ?)").run(
    id,
    userId,
    listId,
    meta.source,
    meta.fileName ?? null,
    Date.now(),
  );
  saveDraft(db, id, draft);
  return getReceipt(db, id)!;
}

/** Your corrections on the review screen. */
export function updateReceipt(db: DB, id: string, draft: ReceiptDraft): Receipt | null {
  const r = getReceipt(db, id);
  if (!r || r.status === "confirmed") return null;
  saveDraft(db, id, draft);
  return getReceipt(db, id);
}

/** Midday on the receipt's date, so time zones can't shift it to another day. */
const dayToTime = (day: string) => Date.parse(`${day}T12:00:00Z`);

/**
 * Turn a checked receipt into purchase history. Ticks for the same products within a day and a half
 * of the receipt are replaced, so ticking an item and scanning its receipt doesn't count it twice.
 */
export function confirmReceipt(db: DB, id: string, userId: string): Receipt | null {
  const r = getReceipt(db, id);
  if (!r || r.status === "confirmed") return null;
  const fp = fingerprint({ store: r.store, date: r.purchasedOn, total: r.total });
  if (fp) {
    const dup = db.prepare("SELECT id FROM receipts WHERE list_id = ? AND fingerprint = ? AND status = 'confirmed' AND id != ?").get(r.listId, fp, id) as
      | { id: string }
      | undefined;
    if (dup) throw new DuplicateReceiptError(dup.id);
  }
  const at = r.purchasedOn ? dayToTime(r.purchasedOn) : r.createdAt;
  db.transaction(() => {
    const dropTick = db.prepare("DELETE FROM purchases WHERE list_id = ? AND name_key = ? AND receipt_id IS NULL AND bought_at BETWEEN ? AND ?");
    const add = db.prepare(`
      INSERT INTO purchases (item_id, user_id, list_id, trip_id, name, name_key, brand, size, qty, section_id, barcode, bought_at, price, receipt_id)
      VALUES (@itemId, @userId, @listId, NULL, @name, @key, @brand, @size, @qty, @sectionId, NULL, @at, @price, @receiptId)
    `);
    for (const l of r.lines.filter((x) => x.isProduct)) {
      const key = nameKey(l.name);
      dropTick.run(r.listId, key, at - 1.5 * 86_400_000, at + 1.5 * 86_400_000);
      add.run({ itemId: `receipt:${id}:${l.idx}`, userId, listId: r.listId, name: l.name, key, brand: l.brand, size: l.size, qty: l.qty, sectionId: l.sectionId, at, price: l.lineTotal, receiptId: id });
    }
    db.prepare("UPDATE receipts SET status = 'confirmed', fingerprint = ? WHERE id = ?").run(fp, id);
  })();
  return getReceipt(db, id);
}

export function deleteReceipt(db: DB, id: string) {
  db.transaction(() => {
    db.prepare("DELETE FROM purchases WHERE receipt_id = ?").run(id);
    db.prepare("DELETE FROM receipt_lines WHERE receipt_id = ?").run(id);
    db.prepare("DELETE FROM receipts WHERE id = ?").run(id);
  })();
}
