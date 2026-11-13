// Runs before every test file (vitest setupFiles). Each test starts with a finished setup, as if
// the Worker had already looked everything up from Discord for the test token, so the older
// suites make no setup calls. Setup tests start from nothing with clearSetup().
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach } from "vitest";
import type { Bridge } from "../src/bridge";
import { sha256Hex } from "../src/keys";
import { commandsHash, type SetupRow } from "../src/setup-row";

function stub(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

export async function seededRow(): Promise<SetupRow> {
  return {
    appId: "test-app-id",
    verifyKey: "test-public-key",
    ownerId: "test-user-id",
    botName: "Test Bot",
    interactionsUrl: "https://example.com/discord/interactions",
    tokenHash: await sha256Hex("test-token"),
    lookedUp: Date.now(),
    commandsHash: await commandsHash(),
    error: null,
    nextTry: 0,
    lastTestDm: 0,
    lastMove: 0,
    move: null,
  };
}

export async function writeSetup(row: SetupRow | null): Promise<void> {
  const json = row ? JSON.stringify(row) : null;
  await runInDurableObject(stub(), (_i, state) => {
    if (json === null) state.storage.sql.exec("DELETE FROM setup");
    else state.storage.sql.exec("INSERT OR REPLACE INTO setup (id, json) VALUES (1, ?)", json);
  });
}

export function clearSetup(): Promise<void> {
  return writeSetup(null);
}

beforeEach(async () => {
  await writeSetup(await seededRow());
});
