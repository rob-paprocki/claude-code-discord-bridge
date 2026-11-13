import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import { approvePending, CREATE_WINDOW_MS, earliest, MAX_CREATED_PER_WINDOW } from "../src/joins";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { type DiscordCall, stubDiscord } from "./helpers/discordRest";

const USER = "test-user-id";
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
  });
}
const enroll = (machine: unknown) =>
  SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
type Join = { id: string; secret: string };
const cancel = (j: Join) =>
  SELF.fetch(`https://example.com/api/enroll/${j.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${j.secret}` } });
const sends = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const patches = () => calls.filter((c) => c.method === "PATCH");
const sqlRows = (sql: string) => runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec(sql).toArray());
async function press(customId: string, content = "x") {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
  const req = await signedInteraction(
    { type: 3, channel_id: "dm1", user: { id: USER }, message: { id: "m1", channel_id: "dm1", content }, data: { custom_id: customId } },
    keyPair,
  );
  return (await (await worker.fetch(req, testEnv, ctx)).json()) as { type: number; data: { content: string; flags?: number; components?: any[] } };
}
async function command() {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
  const req = await signedInteraction({ type: 2, channel_id: "dm1", user: { id: USER }, data: { name: "machines" } }, keyPair);
  return (await (await worker.fetch(req, testEnv, ctx)).json()) as { type: number; data: { content: string; flags?: number; components?: any[] } };
}
const labelsOf = (b: { data: { components?: any[] } }) => (b.data.components ?? []).flatMap((r) => r.components.map((c: any) => c.label as string));

describe("S1 join creation limit", () => {
  it("the 7th enroll in 10 minutes is 429 even when every earlier join was cancelled", async () => {
    expect(MAX_CREATED_PER_WINDOW).toBe(6);
    for (let i = 0; i < 6; i++) {
      const r = await enroll(`c${i}`);
      expect(r.status).toBe(201);
      expect((await cancel((await r.json()) as Join)).status).toBe(200);
    }
    const before = sends().length;
    const busy = await enroll("c6");
    expect(busy.status).toBe(429);
    expect(await busy.text()).toBe("too many joins waiting");
    expect(sends()).toHaveLength(before);
  });

  it("enrolls work again once the window has passed", async () => {
    for (let i = 0; i < 6; i++) await cancel((await (await enroll(`w${i}`)).json()) as Join);
    expect((await enroll("w6")).status).toBe(429);
    await runInDurableObject(bridge(), (_i, state) => {
      for (const r of state.storage.sql.exec("SELECT id, json FROM joins").toArray()) {
        const j = JSON.parse(r.json as string);
        j.created -= CREATE_WINDOW_MS + 1;
        state.storage.sql.exec("UPDATE joins SET json = ? WHERE id = ?", JSON.stringify(j), r.id);
      }
    });
    expect((await enroll("w7")).status).toBe(201);
  });

  it("earliest handles 200k entries", () => {
    const times = Array.from({ length: 200_000 }, (_, i) => 1_000_000 - i);
    expect(earliest(times)).toBe(800_001);
    expect(earliest([5])).toBe(5);
  });
});

describe("S5 streamed body cap", () => {
  const streamOf = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        if (next) c.enqueue(next);
        else c.close();
      },
    });
  it("a chunked body over 16 KB with no Content-Length is 413", async () => {
    const chunk = new TextEncoder().encode("x".repeat(9000));
    const res = await SELF.fetch("https://example.com/api/enroll", {
      method: "POST",
      body: streamOf([chunk, chunk]),
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
    await res.text();
  });
  it("a huge chunked body is not read to the end", async () => {
    // A Worker that buffers the whole body pulls all 200 chunks; the streamed cap stops after ~2.
    const chunk = new TextEncoder().encode("x".repeat(9000));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls > 200) c.close();
        else c.enqueue(chunk);
      },
    });
    const res = await SELF.fetch("https://example.com/api/enroll", {
      method: "POST",
      body,
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
    await res.text();
    expect(pulls).toBeLessThan(50);
  });
  it("a small streamed body still works", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ machine: "streamed" }));
    const res = await SELF.fetch("https://example.com/api/enroll", {
      method: "POST",
      body: streamOf([bytes.slice(0, 5), bytes.slice(5)]),
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(201);
    await res.text();
  });
});

describe("S6 machine names in code spans", () => {
  it("a link-like name is inside backticks and the DM suppresses embeds", async () => {
    await enroll("https://evil.example");
    const m = sends()[0].body;
    expect(m.content).toContain("`https://evil.example`");
    expect(m.content).not.toContain("\\");
    expect(m.flags).toBe(4);
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });
  it("a backtick in the name becomes an apostrophe", async () => {
    await enroll("a`b`c");
    expect(sends()[0].body.content).toContain("`a'b'c`");
  });
  it("edits and /machines carry the span and flag 4", async () => {
    const j = (await (await enroll("https://evil.example")).json()) as Join;
    await cancel(j);
    await vi.waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.content).toContain("`https://evil.example`");
    expect(patches()[0].body.flags).toBe(4);
    const id = "e".repeat(32);
    await runInDurableObject(bridge(), (_i, state) => {
      const m = { id, name: "http://x.example/`y", keyHash: "h", status: "active", joined: 0, lastSeen: null, messageIds: [] };
      state.storage.sql.exec("INSERT INTO machines (id, key_hash, json) VALUES (?, ?, ?)", id, "h", JSON.stringify(m));
    });
    const list = await command();
    expect(list.data.flags).toBe(68);
    expect(list.data.content).toContain("`http://x.example/'y`");
    const redraw = await press(`ml:${id}:remove`);
    expect(redraw.data.flags).toBe(4);
    expect(redraw.data.content).toContain("`http://x.example/'y`");
  });
});

describe("D3 / T6 / D8 labels", () => {
  it("join DM button says Remove this machine; Confirm names the machine", async () => {
    const j = (await (await enroll("laptop")).json()) as Join;
    const approved = await press(`j:${j.id}:approve`);
    expect(labelsOf(approved)).toEqual(["Remove this machine"]);
    const mid = (await sqlRows("SELECT id FROM machines"))[0].id as string;
    const ask = await press(`mc:${mid}:remove`, "**Joined** · `laptop`");
    expect(labelsOf(ask)).toEqual(["Confirm remove laptop", "Cancel"]);
  });
  it("a long name keeps the Confirm label within 80 characters", async () => {
    const j = (await (await enroll("n".repeat(64))).json()) as Join;
    await press(`j:${j.id}:approve`);
    const mid = (await sqlRows("SELECT id FROM machines"))[0].id as string;
    const ask = await press(`mc:${mid}:remove`);
    expect(labelsOf(ask)[0].length).toBeLessThanOrEqual(80);
    expect(labelsOf(ask)[0]).toMatch(/^Confirm remove n+/);
  });
  it("/machines Confirm names the machine; an emptied list says No machines are joined.", async () => {
    const id = "d".repeat(32);
    await runInDurableObject(bridge(), (_i, state) => {
      const m = { id, name: "desk", keyHash: "h", status: "active", joined: 0, lastSeen: null, messageIds: [] };
      state.storage.sql.exec("INSERT INTO machines (id, key_hash, json) VALUES (?, ?, ?)", id, "h", JSON.stringify(m));
    });
    expect(labelsOf(await press(`ml:${id}:remove`))).toEqual(["Confirm remove desk", "Cancel"]);
    const done = await press(`ml:${id}:confirm`);
    expect(done.data.content).toBe("No machines are joined.");
  });
});

describe("L2 failed enroll keeps a join approved meanwhile", () => {
  it("does not delete an approved join when every DM failed", async () => {
    vi.restoreAllMocks();
    calls = stubDiscord(async (c) => {
      if (c.path === "/users/@me/channels") return Response.json({ id: `dm-${c.body.recipient_id}` });
      if (c.method === "POST" && c.path.endsWith("/messages")) {
        // The second user's send fails after the first user's approval has landed.
        if (c.path.includes("dm-u2")) {
          await runInDurableObject(bridge(), (_i, state) => {
            const row = state.storage.sql.exec("SELECT id FROM joins").one();
            approvePending(state.storage.sql, row.id as string, Date.now());
          });
        }
        return Response.json({ code: 50007 }, { status: 403 });
      }
      return undefined;
    }).calls;
    // A second allowed user for this Durable Object instance only; restored afterwards.
    const original: string = await (runInDurableObject as any)(bridge(), (inst: any) => {
      const before = inst.env.ALLOWED_USER_IDS as string;
      inst.env = { ...inst.env, ALLOWED_USER_IDS: "test-user-id,u2" };
      return before;
    });
    try {
      expect((await enroll("racer")).status).toBe(502);
    } finally {
      await (runInDurableObject as any)(bridge(), (inst: any) => {
        inst.env = { ...inst.env, ALLOWED_USER_IDS: original };
      });
    }
    const rows = await sqlRows("SELECT json FROM joins");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].json as string).status).toBe("approved");
  });

  it("still deletes a join that is pending when every DM failed", async () => {
    vi.restoreAllMocks();
    calls = stubDiscord((c) =>
      c.method === "POST" && c.path.endsWith("/messages") ? Response.json({ code: 50007 }, { status: 403 }) : undefined,
    ).calls;
    expect((await enroll("plain")).status).toBe(502);
    expect(await sqlRows("SELECT id FROM joins")).toHaveLength(0);
  });
});
