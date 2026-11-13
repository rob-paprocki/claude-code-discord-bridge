import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import { joinMachine } from "./helpers/machine";
import { stubDiscord } from "./helpers/discordRest";

// The removed shared admin key: now just a key nobody holds.
const OLD_ADMIN = { Authorization: "Bearer test-hook-key" };
const as = (key: string) => ({ Authorization: `Bearer ${key}` });

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
async function clear() {
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
  });
}
const body = (session: string, machine = "ignored") => ({
  kind: "permission",
  machine,
  project: "proj",
  session,
  tool: "Bash",
  preview: "ls",
});
const post = (headers: Record<string, string>, b: unknown) =>
  SELF.fetch("https://example.com/api/requests", { method: "POST", headers, body: JSON.stringify(b) });
const get = (headers: Record<string, string>, id: string) =>
  SELF.fetch(`https://example.com/api/requests/${id}`, { headers });
const release = (headers: Record<string, string>, id: string) =>
  SELF.fetch(`https://example.com/api/requests/${id}/release`, { method: "POST", headers });
const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;

describe("machine keys", () => {
  beforeEach(async () => {
    stubDiscord();
    await clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clear();
  });

  it("machine key works on every hook route", async () => {
    const { key } = await joinMachine("laptop");
    const created = await post(as(key), body("mk-s1"));
    expect(created.status).toBe(201);
    const id = await idOf(created);
    expect((await get(as(key), id)).status).toBe(200);
    expect((await release(as(key), id)).status).toBe(200);
    const end = await SELF.fetch("https://example.com/api/sessions/mk-s1/end", { method: "POST", headers: as(key) });
    expect(end.status).toBe(200);
  });

  it("joined name replaces the reported name", async () => {
    const { key } = await joinMachine("work mac");
    for (const reported of ["liar", ""]) {
      const res = await post(as(key), body("mk-s2", reported));
      expect(res.status).toBe(201);
      const rec = await bridge().get(await idOf(res));
      expect(rec?.machine).toBe("work mac");
      expect(rec?.machineId).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("a machine cannot see another machine's request", async () => {
    const a = await joinMachine("machine-a");
    const b = await joinMachine("machine-b");
    const id = await idOf(await post(as(a.key), body("mk-s3")));
    expect((await get(as(b.key), id)).status).toBe(404);
    expect((await release(as(b.key), id)).status).toBe(404);
    expect((await get(as(a.key), id)).status).toBe(200);
    expect((await get(OLD_ADMIN, id)).status).toBe(401);
    expect((await release(OLD_ADMIN, id)).status).toBe(401);
  });

  it("a request left from the shared key (no machine) is visible to nobody", async () => {
    const a = await joinMachine("machine-c");
    const old = { id: "oldaa", kind: "permission", machine: "mac", project: "p", session: "mk-s4", tool: "Bash", preview: "ls", status: "pending", created: Date.now(), expires: Date.now() + 3600_000, messageIds: [] };
    await runInDurableObject(bridge(), (_i, state) => {
      state.storage.sql.exec("INSERT INTO requests (id, json) VALUES (?, ?)", old.id, JSON.stringify(old));
    });
    expect((await get(as(a.key), old.id)).status).toBe(404);
    expect((await release(as(a.key), old.id)).status).toBe(404);
  });

  it("machines self answers by key kind", async () => {
    const { key } = await joinMachine("laptop");
    const mine = await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ name: "laptop" });
    const admin = await SELF.fetch("https://example.com/api/machines/self", { headers: OLD_ADMIN });
    expect(admin.status).toBe(401);
    const rnd = await SELF.fetch("https://example.com/api/machines/self", { headers: as("ab".repeat(32)) });
    expect(rnd.status).toBe(401);
  });

  it("removed key is refused", async () => {
    const { key } = await joinMachine("laptop");
    const del = await SELF.fetch("https://example.com/api/machines/self", { method: "DELETE", headers: as(key) });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ removed: true });
    expect((await post(as(key), body("mk-s5"))).status).toBe(401);
  });

  it("DELETE machines/self needs a machine key", async () => {
    const res = await SELF.fetch("https://example.com/api/machines/self", { method: "DELETE", headers: OLD_ADMIN });
    expect(res.status).toBe(401);
  });

  it("lastSeen is written at most once a minute", async () => {
    const { key } = await joinMachine("laptop");
    const seen = async () =>
      runInDurableObject(bridge(), (_i, state) =>
        (state.storage.sql.exec("SELECT json FROM machines").toArray().map((r) => JSON.parse(r.json as string)) as { lastSeen: number | null }[])[0].lastSeen,
      );
    expect(await seen()).toBeNull();
    await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) });
    const first = await seen();
    expect(first).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 15));
    await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) });
    expect(await seen()).toBe(first);
  });
});
