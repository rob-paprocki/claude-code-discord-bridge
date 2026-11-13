// The one stored row the Worker sets itself up from: what Discord reported for the bot token,
// plus the setup's progress. The token itself is never stored, only its SHA-256 fingerprint.
import { MACHINES_COMMAND } from "./discord/rest";
import type { Env } from "./env";
import { sha256Hex } from "./keys";
import { allowedUserIds } from "./users";

export type SetupError = {
  step: "lookup" | "url" | "commands";
  kind: "token" | "unreachable" | "rejected" | "other";
  messages: string[];
};

// A request to move the Interactions Endpoint URL to `origin`. The owner gets a DM with a link to
// `origin` carrying a one-time secret (only its hash is stored): Discord sends button presses to
// the URL being replaced, so the answer has to come back by link, not by button.
// messageIds entries are "channel:message", as joins store them.
export interface MoveRequest {
  id: string;
  origin: string;
  secretHash: string;
  created: number;
  expires: number;
  status: "pending" | "moved" | "denied" | "expired";
  messageIds: string[];
  // Set when Discord refused the new address: its field messages.
  refused?: string[];
}

export interface SetupRow {
  appId: string | null;
  verifyKey: string | null;
  ownerId: string | null;
  botName: string | null;
  interactionsUrl: string | null;
  tokenHash: string;
  lookedUp: number;
  commandsHash: string | null;
  error: SetupError | null;
  nextTry: number;
  lastTestDm: number;
  lastMove: number;
  move: MoveRequest | null;
}

export function commandsHash(): Promise<string> {
  return sha256Hex(JSON.stringify(MACHINES_COMMAND));
}

// An optional setting: missing, empty or only spaces means unset.
export function overrideOf(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

// What the Worker runs with: a value set in the environment wins, else the looked-up one.
export interface Config {
  appId: string | null;
  publicKey: string | null;
  allowed: string[];
}

export function resolveConfig(
  env: Pick<Env, "DISCORD_APP_ID" | "DISCORD_PUBLIC_KEY" | "ALLOWED_USER_IDS">,
  row: SetupRow | null,
): Config {
  return {
    appId: overrideOf(env.DISCORD_APP_ID) ?? row?.appId ?? null,
    publicKey: overrideOf(env.DISCORD_PUBLIC_KEY) ?? row?.verifyKey ?? null,
    allowed: allowedUserIds(env.ALLOWED_USER_IDS, row?.ownerId ?? null),
  };
}
