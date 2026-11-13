import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { JOIN_TTL_MS, KEY_PICKUP_MS } from "../src/joins";
import { generateKeyPair, publicKeyHex } from "./helpers/discord";
import { type DiscordCall, stubDiscord } from "./helpers/discordRest";
import { bridge, enroll, enrollRaw, makePress, poll, sqlRows, USER } from "./helpers/join";

let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
beforeEach(async () => {
  // One DM channel per user, so a second allowed user gets its own copy.
  calls = stubDiscord((c) =>
    c.path === "/users/@me/channels" ? Response.json({ id: `dm-${c.body.recipient_id}` }) : undefined,
  ).calls;
  await clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

async function clear() {
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
  });
}
const press = makePress(() => keyPair, () => testEnv);
const sends = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const patches = () => calls.filter((c) => c.method === "PATCH");
const joinRecord = async (id: string) =>
  JSON.parse((await sqlRows(`SELECT json FROM joins WHERE id = '${id}'`))[0].json as string) as { expires: number; messageIds: string[]; status: string };
async function setJoin(id: string, patch: object) {
  await runInDurableObject(bridge(), (_i, state) => {
    const r = state.storage.sql.exec("SELECT json FROM joins WHERE id = ?", id).one();
    state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(r.json as string), ...patch }), id);
  });
}
// Two allowed users for this Durable Object instance only; restored afterwards.
async function withTwoUsers(run: () => Promise<void>) {
  const original: string = await (runInDurableObject as any)(bridge(), (inst: any) => {
    const before = inst.env.ALLOWED_USER_IDS as string;
    inst.env = { ...inst.env, ALLOWED_USER_IDS: "test-user-id,u2" };
    return before;
  });
  try {
    await run();
  } finally {
    await (runInDurableObject as any)(bridge(), (inst: any) => {
      inst.env = { ...inst.env, ALLOWED_USER_IDS: original };
    });
  }
}

describe("join regressions", () => {
  it("join DM goes to every allowed user", async () => {
    await withTwoUsers(async () => {
      const j = await enroll("laptop");
      expect(calls.filter((c) => c.path === "/users/@me/channels").map((c) => c.body.recipient_id)).toEqual([USER, "u2"]);
      expect(sends().map((c) => c.path)).toEqual([`/channels/dm-${USER}/messages`, "/channels/dm-u2/messages"]);
      const rec = await joinRecord(j.id);
      expect(rec.messageIds).toHaveLength(2);
      expect(rec.messageIds.map((m) => m.split(":")[0])).toEqual([`dm-${USER}`, "dm-u2"]);
    });
  });

  it("polling an expired join answers expired", async () => {
    const j = await enroll();
    expect(await poll(j)).toEqual({ status: "pending" });
    await setJoin(j.id, { expires: Date.now() - 1 });
    expect(await poll(j)).toEqual({ status: "expired" });
  });

  it("a new join waits 30 minutes for Approve", async () => {
    const before = Date.now();
    const j = await enroll();
    const after = Date.now();
    const rec = await joinRecord(j.id);
    expect(JOIN_TTL_MS).toBe(30 * 60 * 1000);
    expect(rec.expires).toBeGreaterThanOrEqual(before + JOIN_TTL_MS - 1000);
    expect(rec.expires).toBeLessThanOrEqual(after + JOIN_TTL_MS + 1000);
  });

  it("approve resets the expiry to the key pickup window", async () => {
    const j = await enroll();
    await setJoin(j.id, { expires: Date.now() + 1000 });
    const before = Date.now();
    await press(`j:${j.id}:approve`);
    const after = Date.now();
    const rec = await joinRecord(j.id);
    expect(rec.status).toBe("approved");
    expect(rec.expires).toBeGreaterThanOrEqual(before + KEY_PICKUP_MS - 1000);
    expect(rec.expires).toBeLessThanOrEqual(after + KEY_PICKUP_MS + 1000);
  });

  it("poll after removal answers removed", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    expect((await poll(j)).key).toMatch(/^[0-9a-f]{64}$/);
    const mid = (await sqlRows("SELECT id FROM machines"))[0].id as string;
    await press(`mc:${mid}:confirm`);
    expect(await poll(j)).toEqual({ status: "removed" });
  });

  it("removal before collection frees the slot", async () => {
    // Four enrolls stay within the creation limit of 6 per window.
    const joins = [await enroll("m0"), await enroll("m1"), await enroll("m2")];
    expect((await enrollRaw("m3")).status).toBe(429);
    await press(`j:${joins[0].id}:approve`);
    const mid = (await sqlRows("SELECT id FROM machines"))[0].id as string;
    await press(`mc:${mid}:confirm`);
    expect((await enrollRaw("m3")).status).toBe(201);
  });

  it("ml confirm edits the join DM", async () => {
    const j = await enroll("laptop");
    const [dm, msg] = (await joinRecord(j.id)).messageIds[0].split(":");
    await press(`j:${j.id}:approve`, USER, dm, msg);
    const mid = (await sqlRows("SELECT id FROM machines"))[0].id as string;
    calls.length = 0;
    await press(`ml:${mid}:confirm`);
    const edit = patches().find((c) => c.path === `/channels/${dm}/messages/${msg}`);
    expect(edit).toBeDefined();
    expect(edit!.body.content).toContain("Removed");
  });
});
