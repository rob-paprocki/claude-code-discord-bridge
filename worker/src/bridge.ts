import { DurableObject } from "cloudflare:workers";
import { type DmEdit, editDm, editMessages, type MessageEdit } from "./dm";
import { deleteMessage, DiscordError, openDm, sendMessage, setInteractionsUrl } from "./discord/rest";
import type { Env } from "./env";
import {
  approvePending,
  createJoin,
  deleteJoin,
  deliverKey,
  earliest,
  denyPending,
  expireIfOverdue,
  joinFor,
  joinForMachine,
  loadJoin,
  loadMachine,
  saveJoin,
  saveMachine,
} from "./joins";
import { joinCode, randomHex, sha256Hex } from "./keys";
import { renderRequest } from "./render";
import { renderMoveRequest, renderMoveState } from "./render-move";
import { emptyRow, interactionsUrlFor, runSetup, setupComplete } from "./setup";
import { commandsHash, type MoveRequest, type SetupRow } from "./setup-row";
import { nameSpan, renderJoinRequest, renderJoinState, SUPPRESS_EMBEDS } from "./render-join";
import type {
  Answer,
  JoinRecord,
  JoinStatus,
  MachineRecord,
  NewRequest,
  Principal,
  RequestRecord,
  Status,
} from "./types";
import { allowedUserIds } from "./users";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LAST_SEEN_MS = 60 * 1000;
const DONE_WINDOW_MS = 2 * HOUR_MS;
const RETAIN_MS = 7 * DAY_MS;
const MACHINE_RETAIN_MS = 30 * DAY_MS;
const DEFAULT_STOP_MINUTES = 6;
// The status page's two buttons: each at most once a minute, counted across everyone.
const ACTION_LIMIT_MS = 60 * 1000;
const MOVE_TTL_MS = 10 * 60 * 1000;
const TEST_DM_TEXT = "Test message from your Claude Code bridge: it can DM you.";
// On a fresh deploy the first join can arrive before the setup has found the owner: it waits for
// that lookup, polling this often, for at most this many polls (about 5 s).
const OWNER_POLL_MS = 50;
const OWNER_POLLS = 100;
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no "l"

function randomId(): string {
  const bytes = new Uint8Array(5);
  let id = "";
  // Rejection sampling keeps the letters uniform.
  const limit = 256 - (256 % ID_ALPHABET.length);
  while (id.length < 5) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && id.length < 5) id += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return id;
}

// A request is visible to the machine that made it only. One left from the removed shared key has
// no machineId: nobody sees it, and it expires as usual.
function visibleTo(r: RequestRecord, caller: Principal): boolean {
  return r.machineId === caller.id;
}

export class Bridge extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, json TEXT)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, conversation INTEGER, updated INTEGER)",
    );
    // Ids of purged requests: never issued again, so a press on a very old DM cannot reach a new request.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS purged_ids (id TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS joins (id TEXT PRIMARY KEY, json TEXT)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, key_hash TEXT, json TEXT)",
    );
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS machines_key_hash ON machines (key_hash)");
    // One row: what the Worker looked up from Discord and how far its setup got.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT)");
  }

  // ALLOWED_USER_IDS when set, else the owner looked up from Discord. Read on every call.
  private allowed(): string[] {
    return allowedUserIds(this.env.ALLOWED_USER_IDS, this.loadSetup()?.ownerId ?? null);
  }

  async setupRow(): Promise<SetupRow | null> {
    return this.loadSetup();
  }

  // One setup run at a time, shared by every caller that asks while it is going. It is never run
  // inside blockConcurrencyWhile: Discord's verification PING must reach setupRow() while the
  // run's PATCH is still waiting.
  private setupRun: Promise<SetupRow> | null = null;

  async ensureSetup(origin: string, opts: { force: boolean }): Promise<SetupRow> {
    if (!this.setupRun) {
      const store = { load: () => this.loadSetup(), update: (patch: Partial<SetupRow>) => this.updateSetup(patch) };
      this.setupRun = runSetup(this.env, store, origin, opts.force).finally(() => {
        this.setupRun = null;
      });
    }
    return this.setupRun;
  }

  // The users to DM. With none known yet, starts (or joins) the setup and waits until its lookup
  // has found the owner, the run has ended, or about 5 s have passed. Polls count iterations, not
  // the clock, so a test that fixes Date.now cannot make this wait forever.
  private async ownersFor(origin: string): Promise<string[]> {
    let users = this.allowed();
    if (users.length) return users;
    let done = false;
    void this.autoSetup(origin)
      .catch(() => {})
      .finally(() => {
        done = true;
      });
    for (let i = 0; i < OWNER_POLLS && !users.length && !done; i++) {
      await new Promise((resolve) => setTimeout(resolve, OWNER_POLL_MS));
      users = this.allowed();
    }
    return users.length ? users : this.allowed();
  }

  // The status page's "Send me a test DM".
  async testDm(): Promise<"sent" | "limited" | "no-owner" | { refused: number }> {
    const now = Date.now();
    if (now - (this.loadSetup()?.lastTestDm ?? 0) < ACTION_LIMIT_MS) return "limited";
    const users = this.allowed();
    if (!users.length) return "no-owner";
    this.updateSetup({ lastTestDm: now });
    const token = this.env.DISCORD_BOT_TOKEN;
    try {
      for (const userId of users) {
        const channelId = await this.dmChannel(token, userId);
        await sendMessage(token, channelId, { content: TEST_DM_TEXT });
      }
      return "sent";
    } catch (err) {
      console.error("test DM failed:", err instanceof Error ? err.message : "unknown error");
      return { refused: err instanceof DiscordError ? (err.code ?? err.status) : 0 };
    }
  }

  // The status page's "Move the buttons here": DMs the owner a one-time link to `origin`.
  async requestMove(origin: string): Promise<"sent" | "limited" | "not-needed" | "no-owner" | { refused: number }> {
    // The secret and its hash come first: no await between reading the row and saving it.
    const secret = randomHex(32);
    const secretHash = await sha256Hex(secret);
    const now = Date.now();
    const row = this.loadSetup();
    if (!row?.interactionsUrl || row.interactionsUrl === interactionsUrlFor(origin)) return "not-needed";
    const open = row.move?.status === "pending" && now < row.move.expires;
    if (open || now - row.lastMove < ACTION_LIMIT_MS) return "limited";
    const users = this.allowed();
    if (!users.length) return "no-owner";
    const move: MoveRequest = { id: randomHex(8), origin, secretHash, created: now, expires: now + MOVE_TTL_MS, status: "pending", messageIds: [] };
    this.updateSetup({ lastMove: now, move });
    await this.scheduleAlarm();
    const token = this.env.DISCORD_BOT_TOKEN;
    const message = renderMoveRequest(move, `${origin}/setup/move/${move.id}?k=${secret}`);
    const sent: string[] = [];
    let refused = 0;
    for (const userId of users) {
      try {
        const channelId = await this.dmChannel(token, userId);
        sent.push(`${channelId}:${await sendMessage(token, channelId, message)}`);
      } catch (err) {
        console.error("move DM failed:", err instanceof Error ? err.message : "unknown error");
        refused = err instanceof DiscordError ? (err.code ?? err.status) : 0;
      }
    }
    const current = this.loadSetup()?.move;
    if (current?.id === move.id) {
      // Nobody got the link: the request ends here (the minute's limit still applies).
      if (!sent.length) this.updateSetup({ move: { ...current, status: "expired" } });
      else this.updateSetup({ move: { ...current, messageIds: [...current.messageIds, ...sent] } });
    }
    return sent.length ? "sent" : { refused };
  }

  // The pending move a link names, if its secret matches and it has not expired.
  async moveLink(id: string, secretHash: string): Promise<{ origin: string } | null> {
    const m = this.loadSetup()?.move;
    if (!m || m.id !== id || m.secretHash !== secretHash || m.status !== "pending" || Date.now() >= m.expires) return null;
    return { origin: m.origin };
  }

  // The answer from the move link's page. The request is claimed before the PATCH, so a second
  // submit cannot send a second one.
  async answerMove(
    id: string,
    secretHash: string,
    move: boolean,
  ): Promise<{ result: "moved" | "kept" | "gone" | { refused: string[] }; edits: MessageEdit[] }> {
    const m = this.loadSetup()?.move;
    if (!m || m.id !== id || m.secretHash !== secretHash || m.status !== "pending") return { result: "gone", edits: [] };
    const ended = (done: MoveRequest): MessageEdit[] => {
      this.updateSetup({ move: done });
      return [{ messageIds: done.messageIds, message: renderMoveState(done) }];
    };
    if (Date.now() >= m.expires) return { result: "gone", edits: ended({ ...m, status: "expired" }) };
    if (!move) return { result: "kept", edits: ended({ ...m, status: "denied" }) };
    this.updateSetup({ move: { ...m, status: "moved" } });
    const url = interactionsUrlFor(m.origin);
    try {
      await setInteractionsUrl(this.env.DISCORD_BOT_TOKEN, url);
    } catch (err) {
      console.error("move failed:", err instanceof Error ? err.message : "unknown error");
      const refused = err instanceof DiscordError ? err.fieldMessages : [];
      const current = this.loadSetup()?.move ?? m;
      return { result: { refused }, edits: ended({ ...current, status: "denied", refused }) };
    }
    this.updateSetup({ interactionsUrl: url });
    const current = this.loadSetup()?.move ?? m;
    return { result: "moved", edits: [{ messageIds: current.messageIds, message: renderMoveState({ ...current, status: "moved" }) }] };
  }

  // Ends a move request nobody answered, and edits its DM.
  private async sweepMove(now: number): Promise<void> {
    const m = this.loadSetup()?.move;
    if (!m || m.status !== "pending" || now < m.expires) return;
    const done: MoveRequest = { ...m, status: "expired" };
    this.updateSetup({ move: done });
    await editMessages(this.env, { messageIds: done.messageIds, message: renderMoveState(done) });
  }

  // The run each request starts in the background: nothing to do once setup is complete, and a
  // failed run is retried at most once a minute.
  async autoSetup(origin: string): Promise<void> {
    const row = this.loadSetup();
    const now = Date.now();
    if (row && setupComplete(row, await sha256Hex(this.env.DISCORD_BOT_TOKEN), await commandsHash(), now)) return;
    if (row && now < row.nextTry) return;
    await this.ensureSetup(origin, { force: false });
  }

  private loadSetup(): SetupRow | null {
    const rows = this.ctx.storage.sql.exec("SELECT json FROM setup WHERE id = 1").toArray();
    return rows.length ? (JSON.parse(rows[0].json as string) as SetupRow) : null;
  }

  private saveSetup(row: SetupRow): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO setup (id, json) VALUES (1, ?)", JSON.stringify(row));
  }

  // Merges fields into the stored row (or a fresh one), synchronously: nothing can interleave.
  private updateSetup(patch: Partial<SetupRow>): SetupRow {
    const row = { ...(this.loadSetup() ?? emptyRow()), ...patch };
    this.saveSetup(row);
    return row;
  }

  private load(id: string): RequestRecord | null {
    const rows = this.ctx.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).toArray();
    return rows.length ? (JSON.parse(rows[0].json as string) as RequestRecord) : null;
  }

  private save(r: RequestRecord): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO requests (id, json) VALUES (?, ?)", r.id, JSON.stringify(r));
  }

  private tombstoned(id: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM purged_ids WHERE id = ?", id).toArray().length > 0;
  }

  private setConversation(session: string, on: boolean): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO sessions (session, conversation, updated) VALUES (?, ?, ?)",
      session,
      on ? 1 : 0,
      Date.now(),
    );
  }

  private inConversation(session: string): boolean {
    const rows = this.ctx.storage.sql.exec("SELECT conversation FROM sessions WHERE session = ?", session).toArray();
    return rows.length > 0 && rows[0].conversation === 1;
  }

  private stopSeconds(): number {
    const minutes = Number(this.env.STOP_MINUTES);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STOP_MINUTES) * 60;
  }

  async create(
    r: NewRequest,
    caller: Principal,
  ): Promise<{ id: string; status: Status; mode?: "turn" | "done" | "none"; dmFailed?: true; edits: DmEdit[] }> {
    let id = randomId();
    while (this.load(id) || this.tombstoned(id)) id = randomId();
    const created = Date.now();
    const waits = r.kind === "permission" || r.kind === "question";
    // The hook does not choose the stop mode: the bridge decides it from the session's state.
    const { mode: _ignored, ...fields } = r;
    // A machine's requests carry its name (fixed here, whatever the body said) and its id.
    const owner = { machine: caller.name, machineId: caller.id };
    let mode: "turn" | "done" | "none" | undefined;
    let expires = created + DAY_MS;
    if (r.kind === "stop") {
      if (this.inConversation(r.session)) {
        mode = "turn";
      } else if ((r.elapsedSeconds ?? 0) >= this.stopSeconds()) {
        mode = "done";
        expires = created + DONE_WINDOW_MS;
      } else {
        mode = "none";
      }
    }
    const record: RequestRecord = {
      ...fields,
      ...owner,
      ...(mode ? { mode } : {}),
      id,
      status: waits || mode === "turn" || mode === "done" ? "pending" : r.kind === "notify" ? "sent" : "none",
      created,
      // Only pending requests expire; for the other kinds this just keeps the record well-formed.
      expires,
      messageIds: [],
    };
    this.save(record);
    // A turn end means the terminal moved on: prompts still waiting from this session were answered there.
    const edits: DmEdit[] = r.kind === "stop" ? this.releaseSession(r.session) : [];
    let status: Status = record.status;
    if (waits || record.kind === "notify" || mode === "turn" || mode === "done") {
      // Other calls can run while the sends are in flight, so re-read before writing.
      const sent = await this.sendRequestDm(record);
      const current = this.load(id);
      if (current) {
        current.messageIds = sent.messageIds;
        if (sent.failed && (current.status === "pending" || current.status === "none" || current.status === "sent")) {
          current.status = "released";
        }
        this.save(current);
        status = current.status;
        // Settled while the DM was being sent (answered, released or expired): the copies sent here
        // were born with live buttons, so they get the outcome too.
        if (!sent.failed && ["answered", "released", "expired"].includes(current.status)) edits.push({ record: current });
      }
      if (sent.failed) return { id, status: "released", ...(mode ? { mode } : {}), dmFailed: true, edits };
    }
    await this.scheduleAlarm();
    return mode ? { id, status, mode, edits } : { id, status, edits };
  }

  // DMs every allowed user. A user counts as delivered only when every part was sent (the buttons
  // sit on the last part); a partly sent message is deleted. Fails when no user got the full message.
  private async sendRequestDm(record: RequestRecord): Promise<{ messageIds: string[]; failed: boolean }> {
    const token = this.env.DISCORD_BOT_TOKEN;
    const messages = renderRequest(record);
    const messageIds: string[] = [];
    for (const userId of this.allowed()) {
      const sent: string[] = [];
      let channelId: string | undefined;
      try {
        channelId = await this.dmChannel(token, userId);
        for (const msg of messages) {
          sent.push(await sendMessage(token, channelId, msg));
        }
        for (const mid of sent) messageIds.push(`${channelId}:${mid}`);
      } catch (err) {
        // The error text carries no token or message content.
        console.error("discord send failed:", err instanceof Error ? err.message : "unknown error");
        for (const mid of sent) {
          try {
            await deleteMessage(token, channelId as string, mid);
          } catch {
            // Best effort: the partial message stays, but the request is not marked delivered.
          }
        }
      }
    }
    return { messageIds, failed: messageIds.length === 0 };
  }

  // Starts a join and DMs it to every allowed user. The Worker passes the plain secret only to
  // this method's caller; here it is hashed at once and only the hash is stored.
  async enroll(
    name: string,
    origin?: string,
  ): Promise<
    { ok: true; id: string; code: string; secret: string; messageEdits: MessageEdit[] } | { ok: false; error: "busy" | "dm-failed" }
  > {
    const sql = this.ctx.storage.sql;
    const secret = randomHex(32);
    const j = createJoin(sql, name, joinCode(), await sha256Hex(secret), Date.now());
    if (!j) return { ok: false, error: "busy" };
    const token = this.env.DISCORD_BOT_TOKEN;
    const message = renderJoinRequest(j);
    const sent: string[] = [];
    // Copies stored after the join had already settled: the approve/deny press never saw them.
    const late: string[] = [];
    const users = origin ? await this.ownersFor(origin) : this.allowed();
    for (const userId of users) {
      try {
        const channelId = await this.dmChannel(token, userId);
        const id = `${channelId}:${await sendMessage(token, channelId, message)}`;
        sent.push(id);
        // Each id is stored right after its send, so an approval or denial during the loop sees
        // the copies already out. The awaits above let one land meanwhile: reload the row first.
        const current = loadJoin(sql, j.id);
        if (current) {
          current.messageIds.push(id);
          saveJoin(sql, current);
          if (current.status !== "pending") late.push(id);
        }
      } catch (err) {
        console.error("discord send failed:", err instanceof Error ? err.message : "unknown error");
      }
    }
    if (sent.length === 0) {
      // The sends awaited Discord: only a join still pending is dropped. One approved meanwhile
      // keeps its row and ends through the normal expiry.
      if (loadJoin(sql, j.id)?.status === "pending") deleteJoin(sql, j.id);
      return { ok: false, error: "dm-failed" };
    }
    const messageEdits: MessageEdit[] = [];
    const current = loadJoin(sql, j.id);
    if (current && late.length > 0) {
      // Settled while the sends were in flight: only the late copies get the state, without
      // buttons. The earlier copies were handled by the press that settled it.
      const machine = current.machineId ? loadMachine(sql, current.machineId) : null;
      if (machine) {
        // A later removal edits the late copies too.
        machine.messageIds.push(...late.filter((id) => !machine.messageIds.includes(id)));
        saveMachine(sql, machine);
      }
      messageEdits.push({ messageIds: late, message: { ...renderJoinState(current, machine ?? undefined), components: [] } });
    }
    await this.scheduleAlarm();
    return { ok: true, id: j.id, code: j.code, secret, messageEdits };
  }

  // null means 404: unknown id or wrong secret. The first poll that finds the join approved with
  // its machine awaiting the key creates the key, stores only its hash and answers it once.
  async pollJoin(id: string, secretHash: string): Promise<{ status: JoinStatus | "removed"; key?: string } | null> {
    const sql = this.ctx.storage.sql;
    let j = joinFor(sql, id, secretHash);
    if (!j) return null;
    expireIfOverdue(sql, j, Date.now());
    if (j.status === "approved" && j.machineId && loadMachine(sql, j.machineId)?.status === "awaiting-key") {
      // Hash first: everything after the await is synchronous, so two polls cannot both deliver.
      const key = randomHex(32);
      const keyHash = await sha256Hex(key);
      j = loadJoin(sql, id) ?? j;
      if (deliverKey(sql, j, keyHash, Date.now())) return { status: "approved", key };
      j = loadJoin(sql, id) ?? j;
    }
    if (j.machineId && loadMachine(sql, j.machineId)?.status === "removed") return { status: "removed" };
    return { status: j.status };
  }

  // The active machine holding this key (hash), or null. Writes lastSeen at most once a minute;
  // synchronous after the call starts, so the read-modify-write is atomic.
  async machineByKeyHash(hash: string): Promise<MachineRecord | null> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec("SELECT id FROM machines WHERE key_hash = ?", hash).toArray();
    if (rows.length === 0) return null;
    const m = loadMachine(sql, rows[0].id as string);
    if (!m || m.status !== "active") return null;
    const now = Date.now();
    if (m.lastSeen === null || now - m.lastSeen >= LAST_SEEN_MS) {
      m.lastSeen = now;
      saveMachine(sql, m);
    }
    return m;
  }

  // For the mc: buttons: the machine, or null when unknown.
  async machine(id: string): Promise<MachineRecord | null> {
    return loadMachine(this.ctx.storage.sql, id);
  }

  // For stale j: presses: the join and, when it has one, its machine. No secret check: only signed
  // Discord interactions call this.
  async joinById(id: string): Promise<{ join: JoinRecord; machine?: MachineRecord } | null> {
    const sql = this.ctx.storage.sql;
    const join = loadJoin(sql, id);
    if (!join) return null;
    expireIfOverdue(sql, join, Date.now());
    const machine = join.machineId ? loadMachine(sql, join.machineId) : null;
    return machine ? { join, machine } : { join };
  }

  // For stale mc: presses: the join that created this machine, if its row still exists.
  async joinOfMachine(machineId: string): Promise<JoinRecord | null> {
    return joinForMachine(this.ctx.storage.sql, machineId);
  }

  // Active machines, least recently seen first (never seen counts as oldest, then by joined).
  async listMachines(): Promise<MachineRecord[]> {
    const out: MachineRecord[] = [];
    for (const row of this.ctx.storage.sql.exec("SELECT json FROM machines").toArray()) {
      const m = JSON.parse(row.json as string) as MachineRecord;
      if (m.status === "active") out.push(m);
    }
    return out.sort((a, b) => (a.lastSeen ?? -Infinity) - (b.lastSeen ?? -Infinity) || a.joined - b.joined);
  }

  // The one removal path (DM button, /machines, DELETE /api/machines/self). The key hash stays on
  // the row so lookups find a 'removed' machine and refuse it. The machine's pending requests are
  // released and its join DM becomes Removed; the caller runs the returned edits after responding.
  async removeMachine(id: string): Promise<{ removed: boolean; edits: DmEdit[]; messageEdits: MessageEdit[] }> {
    const sql = this.ctx.storage.sql;
    const m = loadMachine(sql, id);
    if (!m || m.status === "removed") return { removed: false, edits: [], messageEdits: [] };
    const now = Date.now();
    m.status = "removed";
    m.removed = now;
    saveMachine(sql, m);
    const j = joinForMachine(sql, id);
    if (j && j.status === "approved") {
      // Removed before it collected its key: the join ends and frees its slot.
      j.status = "cancelled";
      j.ended = now;
      saveJoin(sql, j);
    }
    const edits: DmEdit[] = [];
    for (const rec of this.allRecords()) {
      if (rec.machineId !== id || rec.status !== "pending") continue;
      const r = this.load(rec.id);
      if (!r || r.status !== "pending") continue;
      r.status = "released";
      r.cleared = true;
      this.save(r);
      this.setConversation(r.session, false);
      edits.push({ record: r });
    }
    const message = j ? renderJoinState(j, m) : { content: `**Removed** · ${nameSpan(m.name)}`, flags: SUPPRESS_EMBEDS };
    await this.scheduleAlarm();
    return { removed: true, edits, messageEdits: [{ messageIds: m.messageIds, message }] };
  }

  private isOwner(userId: string): boolean {
    return this.allowed().includes(userId);
  }

  async approveJoin(
    id: string,
    userId: string,
  ): Promise<{ result: "ok" | "stale" | "forbidden"; join?: JoinRecord; machine?: MachineRecord }> {
    if (!this.isOwner(userId)) return { result: "forbidden" };
    const r = approvePending(this.ctx.storage.sql, id, Date.now());
    if (!r) return { result: "stale" };
    await this.scheduleAlarm();
    return { result: "ok", ...r };
  }

  async denyJoin(id: string, userId: string): Promise<{ result: "ok" | "stale" | "forbidden"; join?: JoinRecord }> {
    if (!this.isOwner(userId)) return { result: "forbidden" };
    const j = denyPending(this.ctx.storage.sql, id, Date.now());
    return j ? { result: "ok", join: j } : { result: "stale" };
  }

  async cancelJoin(id: string, secretHash: string): Promise<{ ok: boolean; edits: MessageEdit[] }> {
    const sql = this.ctx.storage.sql;
    const j = joinFor(sql, id, secretHash);
    if (!j) return { ok: false, edits: [] };
    expireIfOverdue(sql, j, Date.now());
    if (j.status !== "pending") return { ok: false, edits: [] };
    j.status = "cancelled";
    j.ended = Date.now();
    saveJoin(sql, j);
    return { ok: true, edits: [{ messageIds: j.messageIds, message: renderJoinState(j) }] };
  }

  private async dmChannel(token: string, userId: string): Promise<string> {
    const key = `dm:${userId}`;
    const cached = await this.ctx.storage.get<string>(key);
    if (cached) return cached;
    const channelId = await openDm(token, userId);
    await this.ctx.storage.put(key, channelId);
    return channelId;
  }

  // A pending record past its expiry is reported (and stored) as expired.
  async get(id: string): Promise<RequestRecord | null> {
    const r = this.load(id);
    if (r) this.expireIfOverdue(r);
    return r;
  }

  private expireIfOverdue(r: RequestRecord): void {
    if (r.status === "pending" && Date.now() >= r.expires) {
      r.status = "expired";
      this.save(r);
      // An unanswered turn stop must not leave the session waiting on every later turn end.
      if (r.kind === "stop" && r.mode === "turn") this.setConversation(r.session, false);
    }
  }

  async release(id: string, caller: Principal): Promise<{ status: Status; edits: DmEdit[] }> {
    const r = this.load(id);
    if (!r || !visibleTo(r, caller)) return { status: "none", edits: [] };
    const edits: DmEdit[] = [];
    this.setConversation(r.session, false);
    if (r.status === "pending") {
      r.status = "released";
      r.cleared = true;
      this.save(r);
      edits.push({ record: r });
    }
    return { status: r.status, edits };
  }

  async endConversation(session: string): Promise<{ edits: DmEdit[] }> {
    this.setConversation(session, false);
    return { edits: this.releaseSession(session) };
  }

  // Marks the session's pending permission and question requests released (saved before this
  // returns) and returns the DM edits for the caller to run off the response path.
  private releaseSession(session: string): DmEdit[] {
    const released: RequestRecord[] = [];
    for (const r of this.allRecords()) {
      if (r.session !== session || r.status !== "pending" || Date.now() >= r.expires) continue;
      if (r.kind !== "permission" && r.kind !== "question") continue;
      r.status = "released";
      r.cleared = true;
      this.save(r);
      released.push(r);
    }
    return released.map((record) => ({ record }));
  }

  // For the hook's poll: the record. A request stays answerable until it expires, however long
  // the hook has been silent (a sleeping machine looks the same as a dead hook).
  async poll(id: string, caller: Principal): Promise<RequestRecord | null> {
    const r = this.load(id);
    if (!r || !visibleTo(r, caller)) return null;
    this.expireIfOverdue(r);
    return r;
  }

  async answer(id: string, a: Answer, userId: string): Promise<"ok" | "stale" | "forbidden"> {
    const allowed = this.allowed();
    if (!allowed.includes(userId)) return "forbidden";
    const r = this.load(id);
    if (!r || r.status !== "pending" || Date.now() >= r.expires) return "stale";
    r.status = "answered";
    r.answer = a;
    this.save(r);
    // Typed answers open a conversation; Allow/Deny and option buttons leave it as it was.
    if ("type" in a && (a.type === "text" || a.type === "chat")) this.setConversation(r.session, true);
    return "ok";
  }

  // Stores the labels picked for one question. A later call for the same question replaces them.
  // The request is answered once every question has an entry.
  async choose(id: string, qi: number, labels: string[], userId: string): Promise<"ok" | "done" | "stale" | "forbidden"> {
    const allowed = this.allowed();
    if (!allowed.includes(userId)) return "forbidden";
    const r = this.load(id);
    if (!r) return "stale";
    this.expireIfOverdue(r);
    const q = r.questions?.[qi];
    if (r.status !== "pending" || !q || labels.length === 0) return "stale";
    r.partial = { ...r.partial, [q.question]: labels.join(", ") };
    const done = (r.questions ?? []).every((x) => x.question in (r.partial ?? {}));
    if (done) {
      r.status = "answered";
      r.answer = { type: "answers", answers: r.partial };
    }
    this.save(r);
    return done ? "done" : "ok";
  }

  // For a button press: the record, with a pending request past its expiry marked expired first.
  async press(id: string): Promise<{ record: RequestRecord; expired: boolean } | null> {
    const r = this.load(id);
    if (!r) return null;
    this.expireIfOverdue(r);
    return { record: r, expired: r.status === "expired" };
  }

  // "Back to terminal": releases the request with answer {type:"back"}.
  async back(id: string, userId: string): Promise<"ok" | "stale" | "forbidden"> {
    const allowed = this.allowed();
    if (!allowed.includes(userId)) return "forbidden";
    const r = this.load(id);
    if (!r || r.status !== "pending" || Date.now() >= r.expires) return "stale";
    r.status = "released";
    r.answer = { type: "back" };
    this.save(r);
    this.setConversation(r.session, false);
    return "ok";
  }

  private allRecords(): RequestRecord[] {
    return this.ctx.storage.sql
      .exec("SELECT json FROM requests")
      .toArray()
      .map((row) => JSON.parse(row.json as string) as RequestRecord);
  }

  // One alarm, set for the earliest of: a pending request's expiry, a waiting join's expiry (pending,
  // or approved and not yet collected), an ended join's or removed machine's purge time. None when
  // there is nothing to wait for.
  private async scheduleAlarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const times: number[] = this.allRecords().filter((r) => r.status === "pending").map((r) => r.expires);
    for (const row of sql.exec("SELECT json FROM joins").toArray()) {
      const j = JSON.parse(row.json as string) as JoinRecord;
      if (j.status === "pending" || j.status === "approved") times.push(j.expires);
      else if (j.status === "expired" && !j.cleared) times.push(Date.now());
      if (j.ended !== undefined) times.push(j.ended + RETAIN_MS);
    }
    for (const row of sql.exec("SELECT json FROM machines").toArray()) {
      const m = JSON.parse(row.json as string) as MachineRecord;
      if (m.status === "removed" && m.removed !== undefined) times.push(m.removed + MACHINE_RETAIN_MS);
    }
    const move = this.loadSetup()?.move;
    if (move?.status === "pending") times.push(move.expires);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(earliest(times), Date.now()));
  }

  // Expires overdue joins, edits the DM of each expired join once, and purges old rows.
  private async sweepJoins(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec("SELECT id FROM joins").toArray()) {
      const j = loadJoin(sql, row.id as string);
      if (!j) continue;
      if (j.ended !== undefined && j.ended <= now - RETAIN_MS) {
        deleteJoin(sql, j.id);
        continue;
      }
      expireIfOverdue(sql, j, now);
      if (j.status === "expired" && !j.cleared) {
        j.cleared = true;
        saveJoin(sql, j);
        await editMessages(this.env, { messageIds: j.messageIds, message: renderJoinState(j) });
      }
    }
    for (const row of sql.exec("SELECT json FROM machines").toArray()) {
      const m = JSON.parse(row.json as string) as MachineRecord;
      if (m.status === "removed" && m.removed !== undefined && m.removed <= now - MACHINE_RETAIN_MS) {
        sql.exec("DELETE FROM machines WHERE id = ?", m.id);
      }
    }
  }

  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      // Edits to Discord are awaited, so every record is read fresh when its turn comes and its
      // state change is saved before the edit.
      for (const { id } of this.allRecords()) {
        const r = this.load(id);
        if (!r) continue;
        if (r.created <= now - RETAIN_MS) {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO purged_ids (id) VALUES (?)", id);
          this.ctx.storage.sql.exec("DELETE FROM requests WHERE id = ?", id);
          continue;
        }
        this.expireIfOverdue(r);
        // Requests that expired when a poll or a press noticed it still have live buttons.
        if (r.status === "expired" && !r.cleared) {
          r.cleared = true;
          this.save(r);
          await editDm(this.env, { record: r });
        }
      }
      await this.sweepJoins(now);
      await this.sweepMove(now);
    } finally {
      await this.scheduleAlarm();
    }
  }
}
