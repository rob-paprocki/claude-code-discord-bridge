import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { generateKeyPair, publicKeyHex } from "./helpers/discord";
import { stubDiscord, type DiscordCall } from "./helpers/discordRest";
import { bridge, enroll, makePress, poll, sqlRows, USER } from "./helpers/join";
import { joinMachine } from "./helpers/machine";

let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
beforeEach(async () => {
  calls = stubDiscord().calls;
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
const body = async (r: Response) => (await r.json()) as { type: number; data: { content: string; components?: any[] } };
const patches = () => calls.filter((c) => c.method === "PATCH");

describe("approve and deny", () => {
  it("approve hands the key over once", async () => {
    const j = await enroll();
    const res = await body(await press(`j:${j.id}:approve`));
    expect(res.type).toBe(7);
    expect(res.data.content).toContain("Joined");
    const ids = res.data.components![0].components.map((c: any) => c.custom_id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^mc:[0-9a-f]{32}:remove$/);
    const first = await poll(j);
    expect(first.status).toBe("approved");
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await poll(j)).toEqual({ status: "delivered" });
  });

  it("deny refuses the join", async () => {
    const j = await enroll();
    const res = await body(await press(`j:${j.id}:deny`));
    expect(res.type).toBe(7);
    expect(res.data.content).toContain("Denied");
    expect(await poll(j)).toEqual({ status: "denied" });
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(0);
  });

  it("stranger cannot approve", async () => {
    const j = await enroll();
    const res = await body(await press(`j:${j.id}:approve`, "someone-else"));
    expect(res.type).toBe(4);
    expect(res.data.content).toBe("Only the bridge's owner can answer this.");
    expect(await poll(j)).toEqual({ status: "pending" });
  });

  it("second press is already handled", async () => {
    const j = await enroll();
    expect((await body(await press(`j:${j.id}:approve`))).type).toBe(7);
    const again = await body(await press(`j:${j.id}:approve`));
    expect(again.type).toBe(7);
    expect(again.data.content).toContain("Joined");
    const denied = await body(await press(`j:${j.id}:deny`));
    expect(denied.type).toBe(7);
    expect(denied.data.content).toContain("Joined");
  });

  it("a press past the expiry is already handled and expires the join", async () => {
    const j = await enroll();
    await runInDurableObject(bridge(), (_i, state) => {
      const r = state.storage.sql.exec("SELECT id, json FROM joins").one();
      const rec = JSON.parse(r.json as string);
      rec.expires = Date.now() - 1;
      state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify(rec), r.id);
    });
    const late = await body(await press(`j:${j.id}:approve`));
    expect(late.type).toBe(7);
    expect(late.data.content).toContain("Expired. Run the installer again to retry.");
    expect(late.data.components ?? []).toEqual([]);
    expect(await poll(j)).toEqual({ status: "expired" });
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(0);
  });

  it("racing presses settle once", async () => {
    const j = await enroll();
    const [a, d] = await Promise.all([bridge().approveJoin(j.id, USER), bridge().denyJoin(j.id, USER)]);
    expect([a.result, d.result].filter((r) => r === "ok")).toHaveLength(1);
    expect((await sqlRows("SELECT id FROM machines")).length).toBeLessThanOrEqual(1);
  });

  it("racing polls deliver the key once", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    const polls = await Promise.all([poll(j), poll(j), poll(j)]);
    expect(polls.filter((p) => p.key)).toHaveLength(1);
  });

  it("other copies lose their buttons", async () => {
    const j = await enroll();
    await runInDurableObject(bridge(), (_i, state) => {
      const r = state.storage.sql.exec("SELECT id, json FROM joins").one();
      const rec = JSON.parse(r.json as string);
      rec.messageIds = ["dm1:m1", "dm2:m2"];
      state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify(rec), r.id);
    });
    await press(`j:${j.id}:approve`, USER, "dm1", "m1");
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].path).toContain("dm2");
    expect(patches()[0].path).toContain("m2");
    expect(patches()[0].body.components).toEqual([]);
    expect(patches()[0].body.content).toContain("Joined");
  });

  it("machine key is stored hashed", async () => {
    const { key } = await joinMachine("laptop");
    const all = await sqlRows("SELECT key_hash, json FROM machines");
    expect(all).toHaveLength(1);
    expect(String(all[0].key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(`${all[0].key_hash}${all[0].json}`).not.toContain(key);
    const joins = await sqlRows("SELECT json FROM joins");
    expect(JSON.stringify(joins)).not.toContain(key);
    expect(JSON.parse(all[0].json as string).status).toBe("active");
  });
});
