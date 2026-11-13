import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Principal } from "../src/types";
import { stubDiscord } from "./helpers/discordRest";
import { CALLER as DO_CALLER, joinMachine, machineAuth } from "./helpers/machine";

let AUTH: { Authorization: string };
let CALLER: Principal;
const DAY = 24 * 3600 * 1000;

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

beforeEach(async () => {
  ({ headers: AUTH, principal: CALLER } = await machineAuth("mac"));
  stubDiscord();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("hook requests are allow-listed", () => {
  it("hook cannot set answer or status", async () => {
    const res = await SELF.fetch("https://example.com/api/requests", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        kind: "permission",
        machine: "mac",
        project: "proj",
        session: "tidy-allow",
        tool: "Bash",
        preview: "ls",
        answer: { behavior: "allow" },
        status: "answered",
        cleared: true,
        machineId: "someone-else",
        partial: { "Pick one": "A" },
        messageIds: ["c:m"],
        bogus: 1,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const got = await SELF.fetch(`https://example.com/api/requests/${id}`, { headers: AUTH });
    const body = (await got.json()) as { status: string; answer?: unknown };
    expect(body.status).toBe("pending");
    expect(body.answer).toBeUndefined();
    const stored = await bridge().get(id);
    expect(stored?.answer).toBeUndefined();
    expect(stored?.cleared).toBeUndefined();
    expect(stored).not.toHaveProperty("bogus");
    // The machine id comes from the key, never from the body.
    expect(stored?.machineId).toBe(CALLER.id);
    expect(stored).not.toHaveProperty("partial");
    expect(stored?.messageIds ?? []).not.toContain("c:m");
    expect(stored?.tool).toBe("Bash");
  });
});

describe("retention", () => {
  it("retention purges at exactly 7 days", async () => {
    await joinMachine("tidy-gone");
    const T = Date.now();
    // One callback holds the Durable Object: a row set to its purge time would otherwise be swept
    // by the alarm the Bridge arms for it, at a later real clock.
    await runInDurableObject(bridge(), async (instance, state) => {
      const sql = state.storage.sql;
      const { id } = await instance.create({ kind: "notify", machine: "m", project: "p", session: "tidy-ret", text: "x" }, DO_CALLER);
      // A machine removed exactly 30 days ago, a join ended and a record created exactly 7 days ago.
      for (const row of sql.exec("SELECT id, json FROM machines").toArray()) {
        const m = { ...JSON.parse(row.json as string), status: "removed", removed: T - 30 * DAY };
        sql.exec("UPDATE machines SET json = ? WHERE id = ?", JSON.stringify(m), row.id);
      }
      for (const row of sql.exec("SELECT id, json FROM joins").toArray()) {
        const j = { ...JSON.parse(row.json as string), status: "delivered", ended: T - 7 * DAY, expires: T - 7 * DAY };
        sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify(j), row.id);
      }
      const r = JSON.parse(sql.exec("SELECT json FROM requests WHERE id = ?", id).one().json as string);
      sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify({ ...r, status: "sent", created: T - 7 * DAY }), id);
      expect(sql.exec("SELECT id FROM joins").toArray().length).toBeGreaterThan(0);
      expect(sql.exec("SELECT id FROM machines").toArray().length).toBeGreaterThan(0);

      vi.spyOn(Date, "now").mockReturnValue(T);
      try {
        await instance.alarm();
      } finally {
        vi.restoreAllMocks();
      }
      expect(sql.exec("SELECT id FROM joins").toArray()).toHaveLength(0);
      expect(sql.exec("SELECT id FROM machines").toArray()).toHaveLength(0);
      expect(sql.exec("SELECT id FROM requests WHERE id = ?", id).toArray()).toHaveLength(0);
    });
  });
});

