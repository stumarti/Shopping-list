import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import sharp from "sharp";
import type { Assistant, ReceiptFile } from "./ai/index.js";
import type { DB } from "./db.js";
import { runAutoPlan } from "./planning.js";
import { confirmReceipt, DuplicateReceiptError, readReceipt } from "./receipts.js";
import type { Section } from "./sections.js";

// Bulk import for old receipts: drop files into RECEIPTS_INBOX on the server.
//   - each photo or PDF at the top level is one receipt
//   - a sub-folder is one receipt photographed in several parts (the files inside, in name order)
// Imported receipts go straight into history (you can still review or delete them in the app), and
// files move to done/, duplicate/ or failed/ (with a .txt saying why).

const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const PDF = ".pdf";
const UNSUPPORTED: Record<string, string> = {
  ".heic": "HEIC photos can't be read. On the iPhone, set Settings → Camera → Formats → Most Compatible, or export as JPEG.",
  ".heif": "HEIF photos can't be read. Export as JPEG instead.",
};

/** Shrink big phone photos to a size the AI accepts and reads well (long edge 2000px, JPEG). */
export async function toReceiptFile(path: string): Promise<ReceiptFile> {
  const ext = extname(path).toLowerCase();
  if (ext === PDF) return { mediaType: "application/pdf", data: readFileSync(path).toString("base64") };
  if (UNSUPPORTED[ext]) throw new Error(UNSUPPORTED[ext]);
  if (!IMAGE.has(ext)) throw new Error(`Not a receipt file (${ext || "no extension"}). Use JPEG, PNG, WebP or PDF.`);
  const jpeg = await sharp(readFileSync(path)).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { mediaType: "image/jpeg", data: jpeg.toString("base64") };
}

const SETTLE_MS = 10_000;

/** Entries that have finished copying in (nothing changed for 10 seconds). */
function readyEntries(dir: string, now: number): string[] {
  return readdirSync(dir)
    .filter((name) => !["done", "failed", "duplicate"].includes(name) && !name.startsWith("."))
    .filter((name) => {
      const p = join(dir, name);
      const st = statSync(p);
      const newest = st.isDirectory() ? Math.max(st.mtimeMs, ...readdirSync(p).map((f) => statSync(join(p, f)).mtimeMs)) : st.mtimeMs;
      return now - newest > SETTLE_MS;
    })
    .sort();
}

function move(dir: string, name: string, to: "done" | "failed" | "duplicate", note?: string) {
  mkdirSync(join(dir, to), { recursive: true });
  // Never overwrite an earlier file with the same name.
  const target = existsSync(join(dir, to, name)) ? join(dir, to, `${Date.now()}-${name}`) : join(dir, to, name);
  renameSync(join(dir, name), target);
  if (note) writeFileSync(`${target}.txt`, note + "\n");
}

export interface InboxDeps {
  db: DB;
  assistant: Assistant;
  sections: () => Section[];
  dir: string;
  listId: string;
  /** Whose history imported receipts count towards. */
  userId: () => string | null;
}

/** Process whatever's waiting, one receipt at a time. Returns a summary for the log. */
export async function processInbox(deps: InboxDeps, now = Date.now()) {
  const summary = { imported: 0, duplicates: 0, failed: 0 };
  mkdirSync(deps.dir, { recursive: true });
  const userId = deps.userId();
  if (!userId) return summary;
  for (const name of readyEntries(deps.dir, now)) {
    const path = join(deps.dir, name);
    try {
      const parts = statSync(path).isDirectory()
        ? readdirSync(path)
            .filter((f) => !f.startsWith("."))
            .sort()
            .map((f) => join(path, f))
        : [path];
      const files = await Promise.all(parts.map(toReceiptFile));
      const receipt = await readReceipt({ db: deps.db, assistant: deps.assistant, sections: deps.sections() }, userId, deps.listId, files, { source: "inbox", fileName: name });
      confirmReceipt(deps.db, receipt.id, userId);
      move(deps.dir, name, "done");
      summary.imported++;
    } catch (err) {
      if (err instanceof DuplicateReceiptError) {
        move(deps.dir, name, "duplicate", "Already imported.");
        summary.duplicates++;
      } else {
        move(deps.dir, name, "failed", err instanceof Error ? err.message : String(err));
        summary.failed++;
      }
    }
  }
  if (summary.imported) runAutoPlan(deps.db);
  return summary;
}

/** Check the inbox every minute. */
export function watchInbox(deps: InboxDeps, everyMs = 60_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await processInbox(deps);
      if (s.imported || s.failed || s.duplicates) console.log(`receipts inbox: ${s.imported} imported, ${s.duplicates} duplicates, ${s.failed} failed`);
    } catch (err) {
      console.error("receipts inbox failed", err);
    } finally {
      busy = false;
    }
  };
  void tick();
  return setInterval(tick, everyMs);
}
