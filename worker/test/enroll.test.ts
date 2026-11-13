import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import { stubDiscord, type DiscordCall } from "./helpers/discordRest";
import { machineAuth } from "./helpers/machine";

let calls: DiscordCall[];
let failSends = false;

beforeEach(async () => {
  failSends = false;
  calls = stubDiscord((c) =>
    failSends && c.method === "POST" && c.path.endsWith("/messages")
      ? Response.json({ code: 50007 }, { status: 403 })
      : undefined,
  ).calls;
  await clearJoins();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearJoins();
});

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
async function clearJoins() {
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
  });
}
const enroll = (machine: unknown) =>
  SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
const pollWith = (id: string, secret: string) =>
  SELF.fetch(`https://example.com/api/enroll/${id}`, { headers: { Authorization: `Bearer ${secret}` } });
const cancelWith = (id: string, secret: string) =>
  SELF.fetch(`https://example.com/api/enroll/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } });
const sends = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const patches = () => calls.filter((c) => c.method === "PATCH");

describe("enroll", () => {
  it("creates a join and DMs it", async () => {
    const res = await enroll("laptop");
    expect(res.status).toBe(201);
    const j = (await res.json()) as { id: string; code: string; secret: string };
    expect(j.id).toMatch(/^[0-9a-f]{32}$/);
    expect(j.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(j.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/);
    expect(sends()).toHaveLength(1);
    const msg = sends()[0].body;
    expect(msg.content).toContain("laptop");
    expect(msg.content).toContain(j.code);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    const ids = msg.components[0].components.map((c: any) => c.custom_id);
    expect(ids).toEqual([`j:${j.id}:approve`, `j:${j.id}:deny`]);
  });

  it("non-ascii name is refused", async () => {
    expect((await enroll("café")).status).toBe(400);
    expect((await enroll(5)).status).toBe(400);
    expect(sends()).toHaveLength(0);
  });

  it("three waiting joins make the fourth busy", async () => {
    for (let i = 0; i < 3; i++) expect((await enroll(`m${i}`)).status).toBe(201);
    expect((await enroll("m3")).status).toBe(429);
  });

  it("a refused DM drops the join", async () => {
    failSends = true;
    expect((await enroll("a")).status).toBe(502);
    failSends = false;
    for (let i = 0; i < 3; i++) expect((await enroll(`m${i}`)).status).toBe(201);
  });

  it("poll before approval is pending", async () => {
    const j = (await (await enroll("laptop")).json()) as { id: string; secret: string };
    const res = await pollWith(j.id, j.secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("wrong poll secret is 404", async () => {
    const j = (await (await enroll("laptop")).json()) as { id: string; secret: string };
    expect((await pollWith(j.id, "0".repeat(64))).status).toBe(404);
    expect((await pollWith("f".repeat(32), j.secret)).status).toBe(404);
    expect((await cancelWith(j.id, "0".repeat(64))).status).toBe(404);
  });

  it("cancel frees the slot and edits the DM", async () => {
    const js: { id: string; secret: string }[] = [];
    for (let i = 0; i < 3; i++) js.push((await (await enroll(`m${i}`)).json()) as { id: string; secret: string });
    expect((await enroll("m3")).status).toBe(429);
    const res = await cancelWith(js[0].id, js[0].secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "cancelled" });
    expect(await (await pollWith(js[0].id, js[0].secret)).json()).toEqual({ status: "cancelled" });
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.content).toContain("Cancelled");
    expect(patches()[0].body.components).toEqual([]);
    expect((await enroll("m3")).status).toBe(201);
  });

  it("oversized body is 413", async () => {
    const big = JSON.stringify({ machine: "x".repeat(17 * 1024) });
    const a = await SELF.fetch("https://example.com/api/enroll", { method: "POST", body: big });
    expect(a.status).toBe(413);
    const b = await SELF.fetch("https://example.com/api/requests", {
      method: "POST",
      headers: { ...(await machineAuth("x")).headers, "Content-Type": "application/json" },
      body: big,
    });
    expect(b.status).toBe(413);
  });

  it("a cancel that lands while the DMs are sending is not undone", async () => {
    let flipped = false;
    calls = stubDiscord(async (c) => {
      if (c.method === "POST" && c.path.endsWith("/messages") && !flipped) {
        flipped = true;
        await runInDurableObject(bridge(), (_i, state) => {
          for (const r of state.storage.sql.exec("SELECT id, json FROM joins").toArray()) {
            const j = JSON.parse(r.json as string);
            j.status = "cancelled";
            state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify(j), r.id);
          }
        });
      }
      return undefined;
    }).calls;
    const j = (await (await enroll("laptop")).json()) as { id: string; secret: string };
    const res = await pollWith(j.id, j.secret);
    expect(((await res.json()) as { status: string }).status).toBe("cancelled");
  });

  it("storage holds no secret", async () => {
    const j = (await (await enroll("laptop")).json()) as { id: string; secret: string };
    const rows = await runInDurableObject(bridge(), (_i, state) =>
      state.storage.sql.exec("SELECT id, json FROM joins").toArray().map((r) => `${r.id}${r.json}`),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toContain(j.secret);
  });
});
