// The setup engine: everything the Worker can find out or do with the bot token alone.
// 1. Look the application up (id, public key, owner, Interactions Endpoint URL, bot name).
// 2. Point an empty Interactions Endpoint URL here. A URL that points anywhere else is never
//    changed here: moving it takes the owner's Approve in a DM.
// 3. Register /machines when its definition changed.
// The row is saved after each step, so Discord's verification PING (sent while step 2's PATCH
// waits) finds the public key from step 1.
import {
  DiscordError,
  getApplication,
  getBotName,
  registerCommand,
  setInteractionsUrl,
} from "./discord/rest";
import type { Env } from "./env";
import { sha256Hex } from "./keys";
import { commandsHash, overrideOf, type SetupError, type SetupRow } from "./setup-row";

export const SETUP_RETRY_MS = 60 * 1000;
export const LOOKUP_MAX_AGE_MS = 24 * 3600 * 1000;
// How soon the status page may force another lookup.
const FORCE_LOOKUP_MS = 60 * 1000;

// update() merges the given fields into the row as it is stored now, so a run that awaited Discord
// never writes back fields someone else changed meanwhile (a move request, a rate-limit stamp).
export interface SetupStore {
  load(): SetupRow | null;
  update(patch: Partial<SetupRow>): SetupRow;
}

export function interactionsUrlFor(origin: string): string {
  return `${origin}/discord/interactions`;
}

export function emptyRow(): SetupRow {
  return {
    appId: null,
    verifyKey: null,
    ownerId: null,
    botName: null,
    interactionsUrl: null,
    tokenHash: "",
    lookedUp: 0,
    commandsHash: null,
    error: null,
    nextTry: 0,
    lastTestDm: 0,
    lastMove: 0,
    move: null,
  };
}

// Finished, as far as the automatic run is concerned: nothing left to look up, fill in or register.
// A URL pointing elsewhere counts as finished; only the owner can move it.
export function setupComplete(row: SetupRow, tokenHash: string, cmdHash: string, now: number): boolean {
  return (
    row.tokenHash === tokenHash &&
    row.error === null &&
    !!row.interactionsUrl &&
    row.commandsHash === cmdHash &&
    now - row.lookedUp <= LOOKUP_MAX_AGE_MS
  );
}

function classify(err: unknown, step: SetupError["step"]): SetupError {
  if (err instanceof DiscordError) {
    if (err.status === 401) return { step, kind: "token", messages: [] };
    if (err.status === 429 || err.status >= 500) return { step, kind: "unreachable", messages: [] };
    if (step === "url" && err.status === 400) return { step, kind: "rejected", messages: err.fieldMessages };
    return { step, kind: "other", messages: [] };
  }
  // No answer at all (a network error).
  return { step, kind: "unreachable", messages: [] };
}

function lookupDue(row: SetupRow, tokenHash: string, force: boolean, now: number): boolean {
  if (row.tokenHash !== tokenHash || row.lookedUp === 0) return true;
  if (row.error?.step === "lookup") return true;
  // The URL is only ever filled in right after Discord said it is empty: someone may have set it
  // by hand since the last lookup.
  if (!row.interactionsUrl) return true;
  if (now - row.lookedUp > LOOKUP_MAX_AGE_MS) return true;
  return force && now - row.lookedUp >= FORCE_LOOKUP_MS;
}

// One pass over the three steps. Never throws: a failure is stored in the row, with the next
// automatic try a minute away, and the row is returned.
export async function runSetup(
  env: Pick<Env, "DISCORD_BOT_TOKEN" | "DISCORD_APP_ID">,
  store: SetupStore,
  origin: string,
  force: boolean,
): Promise<SetupRow> {
  const token = env.DISCORD_BOT_TOKEN;
  const tokenHash = await sha256Hex(token);
  const cmdHash = await commandsHash();
  let row = store.load() ?? emptyRow();
  // A failed run waits its minute, whoever asks (the status page included), so a bad token or a
  // refused URL costs Discord at most one call a minute. A new token is tried at once.
  if (row.error && row.tokenHash === tokenHash && Date.now() < row.nextTry) return row;
  let step: SetupError["step"] = "lookup";
  try {
    if (lookupDue(row, tokenHash, force, Date.now())) {
      const app = await getApplication(token);
      let botName = app.bot?.username ?? null;
      if (botName === null) botName = await getBotName(token).catch(() => null);
      const sameApp = row.appId === app.id;
      row = store.update({
        appId: app.id,
        verifyKey: app.verify_key,
        // A team-owned application's owner is a team pseudo-user; the person is the team's owner.
        ownerId: app.team ? (app.team.owner_user_id ?? null) : (app.owner?.id ?? null),
        botName,
        interactionsUrl: app.interactions_endpoint_url || null,
        tokenHash,
        lookedUp: Date.now(),
        // Another application has never had /machines registered by this Worker.
        commandsHash: sameApp ? row.commandsHash : null,
        error: null,
      });
    }
    step = "url";
    if (!row.interactionsUrl) {
      const url = interactionsUrlFor(origin);
      await setInteractionsUrl(token, url);
      row = store.update({ interactionsUrl: url });
    }
    step = "commands";
    if (row.commandsHash !== cmdHash) {
      const appId = overrideOf(env.DISCORD_APP_ID) ?? row.appId;
      if (!appId) throw new Error("no application id");
      await registerCommand(token, appId);
      row = store.update({ commandsHash: cmdHash });
    }
    return store.update({ error: null, nextTry: 0 });
  } catch (err) {
    console.error(`setup ${step} failed:`, err instanceof Error ? err.message : "unknown error");
    // The fingerprint is recorded with the failure, so the minute's wait holds for this token.
    return store.update({ error: classify(err, step), nextTry: Date.now() + SETUP_RETRY_MS, tokenHash });
  }
}
