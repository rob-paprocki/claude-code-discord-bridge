import { randomHex } from "./keys";
import type { JoinRecord, MachineRecord } from "./types";

// How long a join waits for Approve in Discord. Long enough for an unattended install whose owner is away.
export const JOIN_TTL_MS = 30 * 60 * 1000;
// After Approve, how long the machine has to collect its key (it polls every few seconds).
export const KEY_PICKUP_MS = 10 * 60 * 1000;
// The window MAX_CREATED_PER_WINDOW counts joins in.
export const CREATE_WINDOW_MS = 10 * 60 * 1000;
export const MAX_WAITING = 3;
// Joins created in any CREATE_WINDOW_MS window, whatever became of them: a cancel frees a waiting slot
// but not this budget, so a loop of enroll and cancel cannot spam the owner.
export const MAX_CREATED_PER_WINDOW = 6;

// The smallest of the times (a loop: spreading a large array into Math.min throws RangeError).
export function earliest(times: number[]): number {
  let min = Infinity;
  for (const t of times) if (t < min) min = t;
  return min;
}

export function createdInWindow(sql: SqlStorage, now: number): number {
  let n = 0;
  for (const row of sql.exec("SELECT json FROM joins").toArray()) {
    const j = JSON.parse(row.json as string) as JoinRecord;
    if (j.created > now - CREATE_WINDOW_MS) n++;
  }
  return n;
}

export function loadJoin(sql: SqlStorage, id: string): JoinRecord | null {
  const rows = sql.exec("SELECT json FROM joins WHERE id = ?", id).toArray();
  return rows.length ? (JSON.parse(rows[0].json as string) as JoinRecord) : null;
}

export function saveJoin(sql: SqlStorage, j: JoinRecord): void {
  sql.exec("INSERT OR REPLACE INTO joins (id, json) VALUES (?, ?)", j.id, JSON.stringify(j));
}

export function deleteJoin(sql: SqlStorage, id: string): void {
  sql.exec("DELETE FROM joins WHERE id = ?", id);
}

// Joins that still hold a slot: pending ones, and approved ones whose key has not been collected.
// An approved join is collected once it is 'delivered', so counting status 'approved' covers it.
export function waitingCount(sql: SqlStorage, now: number): number {
  let n = 0;
  for (const row of sql.exec("SELECT json FROM joins").toArray()) {
    const j = JSON.parse(row.json as string) as JoinRecord;
    if ((j.status === "pending" || j.status === "approved") && j.expires > now) n++;
  }
  return n;
}

// Starts a pending join. Returns null when the slots are full or too many joins were created lately. The caller supplies the hash of
// the poll secret, so the plain secret never reaches storage.
export function createJoin(
  sql: SqlStorage,
  machine: string,
  code: string,
  secretHash: string,
  now: number,
): JoinRecord | null {
  if (waitingCount(sql, now) >= MAX_WAITING || createdInWindow(sql, now) >= MAX_CREATED_PER_WINDOW) return null;
  const j: JoinRecord = {
    id: randomHex(16),
    machine,
    code,
    secretHash,
    status: "pending",
    created: now,
    expires: now + JOIN_TTL_MS,
    messageIds: [],
  };
  saveJoin(sql, j);
  return j;
}

// The join for this id when the poll secret matches, else null (the caller answers 404).
export function joinFor(sql: SqlStorage, id: string, secretHash: string): JoinRecord | null {
  const j = loadJoin(sql, id);
  return j && j.secretHash === secretHash ? j : null;
}

// A pending join past its expiry becomes expired. So does an approved join whose key was never
// collected; its awaiting-key machine row is deleted (it never held a key).
export function expireIfOverdue(sql: SqlStorage, j: JoinRecord, now: number): void {
  if (now < j.expires) return;
  if (j.status === "pending") {
    j.status = "expired";
    j.ended = now;
    saveJoin(sql, j);
  } else if (j.status === "approved") {
    j.status = "expired";
    j.ended = now;
    saveJoin(sql, j);
    const m = j.machineId ? loadMachine(sql, j.machineId) : null;
    if (m && m.status === "awaiting-key") sql.exec("DELETE FROM machines WHERE id = ?", m.id);
  }
}

// The join that created this machine, if its row still exists.
export function joinForMachine(sql: SqlStorage, machineId: string): JoinRecord | null {
  for (const row of sql.exec("SELECT json FROM joins").toArray()) {
    const j = JSON.parse(row.json as string) as JoinRecord;
    if (j.machineId === machineId) return j;
  }
  return null;
}

export function loadMachine(sql: SqlStorage, id: string): MachineRecord | null {
  const rows = sql.exec("SELECT json FROM machines WHERE id = ?", id).toArray();
  return rows.length ? (JSON.parse(rows[0].json as string) as MachineRecord) : null;
}

export function saveMachine(sql: SqlStorage, m: MachineRecord): void {
  sql.exec(
    "INSERT OR REPLACE INTO machines (id, key_hash, json) VALUES (?, ?, ?)",
    m.id,
    m.keyHash,
    JSON.stringify(m),
  );
}

// Approves a pending join: creates the awaiting-key machine and restarts the 10-minute clock for
// collecting it. Synchronous on purpose, so the read-check-write is atomic in the Durable Object.
// Returns null when the join is not pending (or just turned out to be overdue).
export function approvePending(
  sql: SqlStorage,
  id: string,
  now: number,
): { join: JoinRecord; machine: MachineRecord } | null {
  const j = loadJoin(sql, id);
  if (!j) return null;
  expireIfOverdue(sql, j, now);
  if (j.status !== "pending") return null;
  const machine: MachineRecord = {
    id: randomHex(16),
    name: j.machine,
    keyHash: null,
    status: "awaiting-key",
    joined: now,
    lastSeen: null,
    messageIds: j.messageIds,
  };
  j.status = "approved";
  j.machineId = machine.id;
  j.expires = now + KEY_PICKUP_MS;
  saveMachine(sql, machine);
  saveJoin(sql, j);
  return { join: j, machine };
}

// Denies a pending join. Null when the join is not pending.
export function denyPending(sql: SqlStorage, id: string, now: number): JoinRecord | null {
  const j = loadJoin(sql, id);
  if (!j) return null;
  expireIfOverdue(sql, j, now);
  if (j.status !== "pending") return null;
  j.status = "denied";
  j.ended = now;
  saveJoin(sql, j);
  return j;
}

// Hands the key over at the first poll that finds the join approved and its machine awaiting the
// key. Synchronous: the caller computes the key's hash beforehand. Returns false when there is
// nothing to hand over (another poll got there first, or the approval ran out).
export function deliverKey(sql: SqlStorage, j: JoinRecord, keyHash: string, now: number): boolean {
  const m = j.machineId ? loadMachine(sql, j.machineId) : null;
  if (j.status !== "approved" || !m || m.status !== "awaiting-key") return false;
  if (now >= j.expires) {
    expireIfOverdue(sql, j, now);
    return false;
  }
  m.keyHash = keyHash;
  m.status = "active";
  saveMachine(sql, m);
  j.status = "delivered";
  j.ended = now;
  saveJoin(sql, j);
  return true;
}
