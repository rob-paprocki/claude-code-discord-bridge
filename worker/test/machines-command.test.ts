import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { MachineRecord } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { type DiscordCall, stubDiscord } from "./helpers/discordRest";

const USER = "test-user-id";
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 10, 12, 0);
let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];
let pending: Promise<unknown>[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
beforeEach(async () => {
  calls = stubDiscord().calls;
  pending = [];
  await clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
async function clear() {
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
  });
}
async function seed(id: string, name: string, joined: number, lastSeen: number | null) {
  const m: MachineRecord = { id, name, keyHash: `h-${id}`, status: "active", joined, lastSeen, messageIds: [] };
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("INSERT INTO machines (id, key_hash, json) VALUES (?, ?, ?)", id, m.keyHash, JSON.stringify(m));
  });
}
const ctx = () =>
  ({ waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})), passThroughOnException() {} }) as unknown as ExecutionContext;
type Body = { type: number; data: { content: string; flags?: number; components?: any[] } };
async function command(name = "machines", user = USER) {
  const req = await signedInteraction({ type: 2, channel_id: "dm1", user: { id: user }, data: { name } }, keyPair);
  return (await (await worker.fetch(req, testEnv, ctx())).json()) as Body;
}
async function press(customId: string, user = USER) {
  const req = await signedInteraction(
    { type: 3, channel_id: "dm1", user: { id: user }, message: { id: "m1", channel_id: "dm1", content: "x" }, data: { custom_id: customId } },
    keyPair,
  );
  const res = await worker.fetch(req, testEnv, ctx());
  await Promise.all(pending);
  return (await res.json()) as Body;
}
const buttons = (b: Body) => (b.data.components ?? []).flatMap((r) => r.components as { label: string; custom_id: string }[]);
const labels = (b: Body) => buttons(b).map((c) => c.label);
const lines = (b: Body) => b.data.content.split("\n");

describe("/machines", () => {
  it("machines lists least recently seen first", async () => {
    await seed("a".repeat(32), "alpha", T0 - 9 * DAY, T0 - DAY);
    await seed("b".repeat(32), "bravo", T0 - 8 * DAY, null);
    await seed("c".repeat(32), "charlie", T0 - 7 * DAY, T0 - 3 * DAY);
    const b = await command();
    expect(b.type).toBe(4);
    expect(b.data.flags).toBe(68);
    expect(labels(b).map((l) => l.split(" ")[1])).toEqual(["bravo", "charlie", "alpha"]);
    expect(lines(b).map((l) => l.split(" ")[0].replace(/`/g, ""))).toEqual(["bravo", "charlie", "alpha"]);
    expect(lines(b)[0]).toContain("last seen never");
    expect(lines(b)[2]).toContain("last seen 2026-01-09 12:00 UTC");
    expect(lines(b)[2]).toContain("joined 2026-01-01");
  });

  it("at most five rows with a more line", async () => {
    for (let n = 0; n < 7; n++) await seed(String(n).repeat(32), `box${n}`, T0 - n * DAY, T0 - n * 1000);
    const b = await command();
    expect(buttons(b)).toHaveLength(5);
    expect(b.data.content.endsWith("+2 more not shown; remove one to see the rest")).toBe(true);
  });

  it("duplicate names are told apart", async () => {
    await seed("a".repeat(32), "my-laptop", T0 - 5 * DAY, null);
    await seed("b".repeat(32), "my-laptop", T0 - 2 * DAY, null);
    const l = labels(await command());
    expect(l).toHaveLength(2);
    expect(new Set(l).size).toBe(2);
  });

  it("machine labels keep the date", async () => {
    await seed("a".repeat(32), "n".repeat(90), T0 - 5 * DAY, null);
    const l = labels(await command());
    expect(l[0].length).toBeLessThanOrEqual(80);
    expect(l[0]).toMatch(/\(\d{4}-\d{2}-\d{2}\)$/);
  });

  it("same-day duplicates are told apart", async () => {
    await seed("abcdef" + "a".repeat(26), "box", T0 - 2 * DAY, null);
    await seed("uvwxyz" + "b".repeat(26), "box", T0 - 2 * DAY + 1000, null);
    const b = await command();
    const l = labels(b);
    expect(new Set(l).size).toBe(2);
    expect(l.every((x) => x.length <= 80)).toBe(true);
    expect(l.some((x) => x.endsWith(" · abcdef"))).toBe(true);
    expect(lines(b).some((x) => x.endsWith(" · abcdef"))).toBe(true);
    expect(lines(b).some((x) => x.endsWith(" · uvwxyz"))).toBe(true);
  });

  it("list remove confirm and cancel redraw", async () => {
    const a = "a".repeat(32);
    await seed(a, "alpha", T0 - 3 * DAY, T0 - DAY);
    await seed("b".repeat(32), "bravo", T0 - 2 * DAY, T0);
    const ask = await press(`ml:${a}:remove`);
    expect(ask.type).toBe(7);
    expect(buttons(ask).map((c) => c.custom_id)).toEqual([`ml:${a}:confirm`, `ml:${a}:cancel`]);
    const back = await press(`ml:${a}:cancel`);
    expect(back.type).toBe(7);
    expect(labels(back)).toHaveLength(2);
    expect(labels(back)[0]).toMatch(/^Remove alpha/);
    const done = await press(`ml:${a}:confirm`);
    expect(done.type).toBe(7);
    expect(labels(done)).toHaveLength(1);
    expect(labels(done)[0]).toMatch(/^Remove bravo/);
    expect(done.data.content).not.toContain("alpha");
    expect((await bridge().machine(a))?.status).toBe("removed");
  });

  it("empty list says so", async () => {
    const b = await command();
    expect(b.data.content).toBe("No machines are joined.");
    expect(b.data.components ?? []).toEqual([]);
  });

  it("stranger gets refused", async () => {
    const b = await command("machines", "someone-else");
    expect(b.type).toBe(4);
    expect(b.data.flags).toBe(64);
    expect(b.data.content).toBe("Only the bridge's owner can answer this.");
    const a = "a".repeat(32);
    await seed(a, "alpha", T0, null);
    const p = await press(`ml:${a}:confirm`, "someone-else");
    expect(p.data.content).toBe("Only the bridge's owner can answer this.");
    expect((await bridge().machine(a))?.status).toBe("active");
  });

  it("list text fits discord", async () => {
    for (let n = 0; n < 5; n++) await seed(String(n).repeat(32), `${n}${"x*_".repeat(21)}`, T0 - n * DAY, T0 - n * 1000);
    const b = await command();
    expect(b.data.content.length).toBeLessThanOrEqual(2000);
    expect(buttons(b)).toHaveLength(5);
    for (const l of labels(b)) expect(l.length).toBeLessThanOrEqual(80);
  });
});
