import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DB } from "./db.js";

// Tokens and invite codes are random secrets; only their SHA-256 is stored, so a copy of the
// database can't be used to sign in.
export const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const secret = (bytes: number) => randomBytes(bytes).toString("base64url");

export interface User {
  id: string;
  name: string;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createUser(db: DB, name: string): User {
  const user = { id: randomUUID(), name: name.trim() };
  db.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(user.id, user.name, Date.now());
  return user;
}

export function issueToken(db: DB, userId: string, device: string | null): string {
  const token = secret(32);
  db.prepare("INSERT INTO tokens (hash, user_id, device, created_at) VALUES (?, ?, ?, ?)").run(hash(token), userId, device, Date.now());
  return token;
}

export function authenticate(db: DB, token: string): User | null {
  if (!token) return null;
  const h = hash(token);
  const row = db
    .prepare("SELECT u.id, u.name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.revoked_at IS NULL")
    .get(h) as User | undefined;
  if (!row) return null;
  db.prepare("UPDATE tokens SET last_seen = ? WHERE hash = ?").run(Date.now(), h);
  return row;
}

export function revokeToken(db: DB, token: string): void {
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL").run(Date.now(), hash(token));
}

export function revokeUser(db: DB, userId: string): number {
  return db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), userId).changes;
}

/** forUser set = "add another device for this person"; unset = "invite a new person". */
export function createInvite(db: DB, createdBy: string, forUser: string | null): { code: string; expiresAt: number } {
  const code = secret(18);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.prepare("INSERT INTO invites (hash, created_by, for_user, expires_at) VALUES (?, ?, ?, ?)").run(hash(code), createdBy, forUser, expiresAt);
  return { code, expiresAt };
}

export type JoinResult = { ok: true; user: User; token: string } | { ok: false; error: string };

export function redeemInvite(db: DB, code: string, name: string | undefined, device: string | null): JoinResult {
  return db.transaction((): JoinResult => {
    const invite = db.prepare("SELECT * FROM invites WHERE hash = ?").get(hash(code)) as
      | { for_user: string | null; expires_at: number; used_at: number | null }
      | undefined;
    if (!invite || invite.used_at || invite.expires_at < Date.now()) {
      return { ok: false, error: "This invite has expired or was already used. Ask for a new one." };
    }
    let user: User;
    if (invite.for_user) {
      user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(invite.for_user) as User;
    } else {
      if (!name?.trim()) return { ok: false, error: "Enter your name to join." };
      user = createUser(db, name);
    }
    db.prepare("UPDATE invites SET used_at = ? WHERE hash = ?").run(Date.now(), hash(code));
    return { ok: true, user, token: issueToken(db, user.id, device) };
  })();
}

export function listPeople(db: DB) {
  return db
    .prepare(
      `SELECT u.id, u.name,
              COUNT(t.hash) AS devices,
              MAX(t.last_seen) AS lastSeen
       FROM users u LEFT JOIN tokens t ON t.user_id = u.id AND t.revoked_at IS NULL
       GROUP BY u.id ORDER BY u.created_at`,
    )
    .all() as Array<{ id: string; name: string; devices: number; lastSeen: number | null }>;
}
