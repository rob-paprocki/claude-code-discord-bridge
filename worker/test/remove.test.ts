import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { type DiscordCall, stubDiscord } from "./helpers/discordRest";
import { joinMachine, machineAuth } from "./helpers/machine";

const USER = "test-user-id";
const as = (key: string) => ({ Authorization: `Bearer ${key}` });
const DAY = 24 * 3600 * 1000;
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

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
async function clear() {
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
    state.storage.sql.exec("DELETE FROM requests WHERE json LIKE '%rm-session%'");
  });
}
type Join = { id: string; secret: string };
async function enroll(machine = "laptop"): Promise<Join> {
  const res = await SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Join;
}
const poll = async (j: Join) =>
  (await (await SELF.fetch(`https://example.com/api/enroll/${j.id}`, { headers: { Authorization: `Bearer ${j.secret}` } })).json()) as {
    status: string;
    key?: string;
  };
async function press(customId: string, user = USER, channel = "dm1", message = "m1", content = "x") {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
  const req = await signedInteraction(
    { type: 3, channel_id: channel, user: { id: user }, message: { id: message, channel_id: channel, content }, data: { custom_id: customId } },
    keyPair,
  );
  return worker.fetch(req, testEnv, ctx);
}
const body = async (r: Response) => (await r.json()) as { type: number; data: { content: string; components?: any[] } };
const patches = () => calls.filter((c) => c.method === "PATCH");
const sqlRows = (sql: string) => runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec(sql).toArray());
const machineId = async () => (await sqlRows("SELECT id FROM machines"))[0].id as string;
async function setJoin(id: string, patch: object) {
  await runInDurableObject(bridge(), (_i, state) => {
    const r = state.storage.sql.exec("SELECT json FROM joins WHERE id = ?", id).one();
    state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(r.json as string), ...patch }), id);
  });
}
const alarm = () => runInDurableObject(bridge(), (_i, state) => state.storage.getAlarm());

describe("removing a machine", () => {
  it("remove then confirm removes the machine", async () => {
    const { key } = await joinMachine("laptop");
    const mid = await machineId();
    const ask = await body(await press(`mc:${mid}:remove`, USER, "dm1", "m1", "**Joined** · laptop"));
    expect(ask.type).toBe(7);
    expect(ask.data.content).toBe("**Joined** · laptop");
    expect(ask.data.components![0].components.map((c: any) => [c.custom_id, c.style])).toEqual([
      [`mc:${mid}:confirm`, 4],
      [`mc:${mid}:cancel`, expect.any(Number)],
    ]);
    expect((await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) })).status).toBe(200);
    const done = await body(await press(`mc:${mid}:confirm`));
    expect(done.type).toBe(7);
    expect(done.data.content).toContain("Removed");
    expect(done.data.components ?? []).toEqual([]);
    expect((await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) })).status).toBe(401);
    for (const action of ["confirm", "remove"]) {
      const late = await body(await press(`mc:${mid}:${action}`));
      expect(late.type).toBe(7);
      expect(late.data.content).toContain("Removed");
      expect(late.data.components ?? []).toEqual([]);
    }
  });

  it("a press on a purged machine says it is no longer available", async () => {
    await joinMachine("laptop");
    const mid = await machineId();
    await press(`mc:${mid}:confirm`);
    await runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec("DELETE FROM machines WHERE id = ?", mid));
    for (const action of ["remove", "confirm", "cancel"]) {
      const res = await body(await press(`mc:${mid}:${action}`, USER, "dm1", "m1", "**Joined** · `old-laptop`"));
      expect(res.type).toBe(7);
      expect(res.data.components ?? []).toEqual([]);
      expect(res.data.content.endsWith("No longer available.")).toBe(true);
      expect(res.data.content).toContain("old-laptop");
    }
  });

  it("cancel keeps the machine", async () => {
    const { key } = await joinMachine("laptop");
    const mid = await machineId();
    await press(`mc:${mid}:remove`, USER, "dm1", "m1", "**Joined** · laptop");
    const back = await body(await press(`mc:${mid}:cancel`, USER, "dm1", "m1", "**Joined** · laptop"));
    expect(back.type).toBe(7);
    expect(back.data.content).toBe("**Joined** · laptop");
    expect(back.data.components![0].components.map((c: any) => c.custom_id)).toEqual([`mc:${mid}:remove`]);
    expect((await SELF.fetch("https://example.com/api/machines/self", { headers: as(key) })).status).toBe(200);
  });

  it("a stranger cannot remove", async () => {
    await joinMachine("laptop");
    const mid = await machineId();
    const res = await body(await press(`mc:${mid}:confirm`, "someone-else"));
    expect(res.data.content).toBe("Only the bridge's owner can answer this.");
    expect(JSON.parse((await sqlRows("SELECT json FROM machines"))[0].json as string).status).toBe("active");
  });

  it("remove before delivery gets no key", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    const mid = await machineId();
    await press(`mc:${mid}:confirm`);
    expect(await poll(j)).toEqual({ status: "removed" });
  });

  it("remove and cancel work on an approved-uncollected machine", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    const mid = await machineId();
    const ask = await body(await press(`mc:${mid}:remove`, USER, "dm1", "m1", "**Joined** · laptop"));
    expect(ask.type).toBe(7);
    expect(ask.data.components![0].components.map((c: any) => c.custom_id)).toEqual([`mc:${mid}:confirm`, `mc:${mid}:cancel`]);
    const back = await body(await press(`mc:${mid}:cancel`, USER, "dm1", "m1", "**Joined** · laptop"));
    expect(back.type).toBe(7);
    expect(back.data.components![0].components.map((c: any) => c.custom_id)).toEqual([`mc:${mid}:remove`]);
    expect((await poll(j)).status).toBe("approved");
  });

  it("DELETE /api/machines/self edits the join DM", async () => {
    const { key } = await joinMachine("laptop");
    const mid = await machineId();
    await runInDurableObject(bridge(), (_i, state) => {
      const r = state.storage.sql.exec("SELECT json FROM machines WHERE id = ?", mid).one();
      state.storage.sql.exec("UPDATE machines SET json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(r.json as string), messageIds: ["dmx:mx"] }), mid);
    });
    const res = await SELF.fetch("https://example.com/api/machines/self", { method: "DELETE", headers: as(key) });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(patches().some((p) => p.path.includes("dmx") && p.body.content.includes("Removed"))).toBe(true));
  });

  it("removing releases its pending prompts", async () => {
    const { key } = await joinMachine("laptop");
    const created = await SELF.fetch("https://example.com/api/requests", {
      method: "POST",
      headers: as(key),
      body: JSON.stringify({ kind: "permission", machine: "x", project: "p", session: "rm-session", tool: "Bash", preview: "ls" }),
    });
    const { id } = (await created.json()) as { id: string };
    calls.length = 0;
    const mid = await machineId();
    await press(`mc:${mid}:confirm`);
    // The machine's own key is gone with it, so the record is read directly.
    expect((await bridge().get(id))?.status).toBe("released");
    await vi.waitFor(() => expect(patches().some((p) => p.body.content.includes("Back at the terminal."))).toBe(true));
  });
});

describe("join expiry and retention", () => {
  it("pending join expires", async () => {
    const j = await enroll();
    await setJoin(j.id, { expires: Date.now() - 1 });
    calls.length = 0;
    await runDurableObjectAlarm(bridge());
    expect(await poll(j)).toEqual({ status: "expired" });
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body.content).toContain("Expired. Run the installer again to retry.");
    expect(patches()[0].body.components).toEqual([]);
  });

  it("a join expired by a poll still gets its DM edited by the alarm, once", async () => {
    const j = await enroll();
    await setJoin(j.id, { expires: Date.now() - 1 });
    expect(await poll(j)).toEqual({ status: "expired" });
    calls.length = 0;
    await runDurableObjectAlarm(bridge());
    expect(patches()).toHaveLength(1);
    await runDurableObjectAlarm(bridge());
    expect(patches()).toHaveLength(1);
  });

  it("approved join expires before collection", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(1);
    await setJoin(j.id, { expires: Date.now() - 1 });
    calls.length = 0;
    await runDurableObjectAlarm(bridge());
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(0);
    expect(patches()[0].body.content).toContain("Expired. Run the installer again to retry.");
    expect(await poll(j)).toEqual({ status: "expired" });
  });

  it("an approved join polled after its expiry gets no key and loses its machine row", async () => {
    const j = await enroll();
    await press(`j:${j.id}:approve`);
    await setJoin(j.id, { expires: Date.now() - 1 });
    expect(await poll(j)).toEqual({ status: "expired" });
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(0);
  });

  it("join alarm survives hook traffic", async () => {
    await runInDurableObject(bridge(), (_i, state) => state.storage.deleteAlarm());
    await enroll();
    expect(await alarm()).not.toBeNull();
    const stop = await SELF.fetch("https://example.com/api/requests", {
      method: "POST",
      headers: (await machineAuth("m")).headers,
      body: JSON.stringify({ kind: "stop", machine: "m", project: "p", session: "rm-session", elapsedSeconds: 1 }),
    });
    expect(stop.status).toBe(201);
    expect(await alarm()).not.toBeNull();
  });

  it("approving schedules the alarm for the collection deadline", async () => {
    const j = await enroll();
    await runInDurableObject(bridge(), (_i, state) => state.storage.deleteAlarm());
    await press(`j:${j.id}:approve`);
    expect(await alarm()).not.toBeNull();
  });

  it("old rows are purged", async () => {
    const j = await enroll();
    await setJoin(j.id, { status: "delivered", ended: Date.now() - 8 * DAY, expires: Date.now() - 8 * DAY });
    const fresh = await enroll("fresh");
    await joinMachine("gone");
    await runInDurableObject(bridge(), (_i, state) => {
      for (const row of state.storage.sql.exec("SELECT id, json FROM machines").toArray()) {
        const m = { ...JSON.parse(row.json as string), status: "removed", removed: Date.now() - 31 * DAY };
        state.storage.sql.exec("UPDATE machines SET json = ? WHERE id = ?", JSON.stringify(m), row.id);
      }
    });
    await runDurableObjectAlarm(bridge());
    const ids = (await sqlRows("SELECT id FROM joins")).map((r) => r.id);
    expect(ids).not.toContain(j.id);
    expect(ids).toContain(fresh.id);
    expect(await sqlRows("SELECT id FROM machines")).toHaveLength(0);
  });
});
