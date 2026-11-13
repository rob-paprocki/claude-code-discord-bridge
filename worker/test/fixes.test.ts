import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { NewRequest, Principal, RequestRecord } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscord, type DiscordCall } from "./helpers/discordRest";
import { machineAuth } from "./helpers/machine";

const USER = "test-user-id";
// One joined machine per test: AUTH for hook calls, CALLER for direct Durable Object calls.
let AUTH: { Authorization: string };
let CALLER: Principal;
const base = { machine: "mac", project: "proj" };

let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
// While set, Discord message edits (PATCH) never complete.
let hangEdits = false;
beforeEach(async () => {
  ({ headers: AUTH, principal: CALLER } = await machineAuth("mac"));
  hangEdits = false;
  calls = stubDiscord((c) => (c.method === "PATCH" && hangEdits ? new Promise<Response>(() => {}) : undefined)).calls;
});
afterEach(() => vi.restoreAllMocks());

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
const permission = (session: string, preview = "ls") =>
  bridge().create({ kind: "permission", ...base, session, tool: "Bash", preview }, CALLER);
const stop = (session: string, r: Partial<NewRequest> = {}) =>
  bridge().create({ kind: "stop", ...base, session, text: "all done", ...r }, CALLER);
const question = (session: string) =>
  bridge().create({
    kind: "question",
    ...base,
    session,
    questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  }, CALLER);
const release = (id: string) => SELF.fetch(`https://example.com/api/requests/${id}/release`, { method: "POST", headers: AUTH });
const poll = (id: string) => SELF.fetch(`https://example.com/api/requests/${id}`, { headers: AUTH });
const stopViaApi = (session: string, r: Partial<NewRequest> = {}) =>
  SELF.fetch("https://example.com/api/requests", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "stop", ...base, session, text: "all done", ...r }),
  });
const edits = () => calls.filter((c) => c.method === "PATCH");

async function setRecord(id: string, patch: Partial<RequestRecord>) {
  await runInDurableObject(bridge(), (_i, state) => {
    const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one();
    const rec = { ...JSON.parse(row.json as string), ...patch };
    state.storage.sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify(rec), id);
  });
}

async function send(body: object): Promise<any> {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(await signedInteraction(body, keyPair), testEnv, ctx);
  await Promise.all(waits);
  return res.json();
}
const press = (customId: string, content = "x") =>
  send({ type: 3, member: { user: { id: USER } }, message: { id: "m1", channel_id: "dm-channel", content }, data: { custom_id: customId, component_type: 2 } });

describe("release edits the DM", () => {
  it("release edits the DM to back at the terminal", async () => {
    const a = await permission("f1a", "npm test");
    calls.length = 0;
    await release(a.id);
    expect(edits()).toHaveLength(1);
    expect(edits()[0].path).toMatch(/^\/channels\/dm-channel\/messages\/m\d+$/);
    expect(edits()[0].body.components).toEqual([]);
    expect(edits()[0].body.content).toContain("npm test");
    expect(edits()[0].body.content).toMatch(/\nBack at the terminal\.$/);
    expect((await bridge().get(a.id))?.cleared).toBe(true);
    // A second release does not edit again.
    calls.length = 0;
    await release(a.id);
    expect(edits()).toHaveLength(0);
  });

  it("releasing a turn says back at the terminal", async () => {
    const first = await permission("f1b");
    await bridge().answer(first.id, { type: "chat", text: "hi" }, USER);
    const turn = await stop("f1b", { elapsedSeconds: 1, text: "the reply" });
    calls.length = 0;
    await release(turn.id);
    expect(edits()[0].body.content).toContain("the reply");
    expect(edits()[0].body.content).toMatch(/\nBack at the terminal\.$/);
  });

  it("a purged id is never reissued", async () => {
    const a = await permission("f1c");
    await setRecord(a.id, { created: Date.now() - 8 * 24 * 3600 * 1000, expires: 1, status: "answered" });
    await runDurableObjectAlarm(bridge());
    expect(await bridge().get(a.id)).toBeNull();
    expect(await bridge().press(a.id)).toBeNull();
    expect(await bridge().answer(a.id, { behavior: "allow" }, USER)).toBe("stale");
    expect((await press(`b:${a.id}:allow`)).data.content).toBe("x\nNo longer available.");
    // The next id the generator offers is the purged one, then a fresh one.
    const real = crypto.getRandomValues.bind(crypto);
    const letters = a.id.split("").map((c) => "abcdefghijkmnopqrstuvwxyz".indexOf(c));
    let first = true;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      if (first && arr.length === 5) {
        first = false;
        arr.set(letters);
        return arr;
      }
      return real(arr);
    }) as typeof crypto.getRandomValues);
    const b = await permission("f1c");
    expect(first).toBe(false);
    expect(b.id).not.toBe(a.id);
  });
});

describe("DM bodies survive", () => {
  it("expiry keeps the DM body", async () => {
    const done = await stop("f3a", { elapsedSeconds: 3600, text: "the reply text" });
    const perm = await permission("f3b", "git push --force");
    await setRecord(done.id, { expires: Date.now() - 1000 });
    await setRecord(perm.id, { expires: Date.now() - 1000 });
    calls.length = 0;
    await runDurableObjectAlarm(bridge());
    const bodies = edits().map((c) => c.body.content as string);
    expect(bodies.find((b) => b.includes("the reply text"))).toMatch(/\nReply window closed\.$/);
    expect(bodies.find((b) => b.includes("git push --force"))).toMatch(/\nExpired\. Answer in the terminal\.$/);
    for (const c of edits()) expect(c.body.components).toEqual([]);
  });

  it("the type-7 outcome line is escaped", async () => {
    const a = await permission("f3c");
    const res = await send({
      type: 5,
      user: { id: USER },
      message: { id: "m1", channel_id: "dm-channel", content: "x" },
      data: {
        custom_id: `m:${a.id}:chat`,
        components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: "**bold** <@123> @everyone" }] }],
      },
    });
    expect(res.data.content).toBe("x\nChat: \\*\\*bold\\*\\* \\<\\@123\\> \\@everyone");
  });
});

describe("answers are held until the hook wakes", () => {
  it("a press on a request not polled for hours is still accepted", async () => {
    const a = await permission("f5a");
    await setRecord(a.id, { created: Date.now() - 5 * 3600 * 1000 });
    calls.length = 0;
    const res = await press(`b:${a.id}:allow`);
    expect(res.data.content).toBe("x\nAllowed");
    expect(edits()).toHaveLength(0);
    const rec = await bridge().get(a.id);
    expect(rec?.status).toBe("answered");
    expect(rec?.answer).toEqual({ behavior: "allow" });
  });

  it("a typed chat reply on a long-unpolled request is accepted and turns conversation mode on", async () => {
    const a = await permission("f5c");
    await setRecord(a.id, { created: Date.now() - 3 * 3600 * 1000 });
    const res = await send({
      type: 5,
      user: { id: USER },
      message: { id: "m1", channel_id: "dm-channel", content: "x" },
      data: { custom_id: `m:${a.id}:chat`, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: "later" }] }] },
    });
    expect(res.data.content).toBe("x\nChat: later");
    expect((await bridge().get(a.id))?.answer).toEqual({ type: "chat", text: "later" });
    expect((await stop("f5c", { elapsedSeconds: 1 })).mode).toBe("turn");
  });

  it("a Reply on a Done DM not polled for an hour is accepted", async () => {
    const d = await stop("f5e", { elapsedSeconds: 3600 });
    await setRecord(d.id, { created: Date.now() - 3600 * 1000 });
    expect((await press(`b:${d.id}:reply`)).data.custom_id).toBe(`m:${d.id}:reply`);
    const submitted = await send({
      type: 5,
      user: { id: USER },
      message: { id: "m1", channel_id: "dm-channel", content: "x" },
      data: { custom_id: `m:${d.id}:reply`, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: "late" }] }] },
    });
    expect(submitted.data.content).toBe("x\nAnswered: late");
    expect((await bridge().get(d.id))?.answer).toEqual({ type: "text", text: "late" });
  });

  it("a Done DM past its 2 hour window is still refused", async () => {
    const d = await stop("f5g", { elapsedSeconds: 3600 });
    await setRecord(d.id, { created: Date.now() - 3 * 3600 * 1000, expires: Date.now() - 1000 });
    expect((await press(`b:${d.id}:reply`)).data.content).toBe("x\nReply window closed.");
    // Clear the expired DM now so it does not leak into later tests' alarms.
    await runDurableObjectAlarm(bridge());
  });
});

describe("slow Discord edits stay off the response path", () => {
  const within = <T>(p: Promise<T>, ms = 2000) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("response waited for Discord")), ms))]);
  const bgCtx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

  it("an Allow press answers before the other copy's edit finishes", async () => {
    const a = await permission("f8a");
    await setRecord(a.id, { messageIds: ["dm-channel:m1", "other-channel:m9"] });
    hangEdits = true;
    const req = await signedInteraction(
      { type: 3, member: { user: { id: USER } }, message: { id: "m1", channel_id: "dm-channel", content: "x" }, data: { custom_id: `b:${a.id}:allow`, component_type: 2 } },
      keyPair,
    );
    const res = await within(worker.fetch(req, testEnv, bgCtx()));
    const body = (await res.json()) as any;
    expect(body.data.content).toBe("x\nAllowed");
    expect((await bridge().get(a.id))?.status).toBe("answered");
  });

  it("a stop that releases a pending permission answers before the edit finishes", async () => {
    const a = await permission("f8b");
    hangEdits = true;
    const res = await within(
      worker.fetch(
        new Request("https://example.com/api/requests", {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "stop", ...base, session: "f8b", text: "t", elapsedSeconds: 1 }),
        }),
        testEnv,
        bgCtx(),
      ),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).mode).toBe("none");
    expect((await bridge().get(a.id))?.status).toBe("released");
  });

  it("release and session end answer before the edit finishes", async () => {
    const a = await permission("f8c");
    const b = await permission("f8d");
    hangEdits = true;
    const rel = await within(worker.fetch(new Request(`https://example.com/api/requests/${a.id}/release`, { method: "POST", headers: AUTH }), testEnv, bgCtx()));
    expect(await rel.json()).toEqual({ status: "released" });
    const end = await within(worker.fetch(new Request("https://example.com/api/sessions/f8d/end", { method: "POST", headers: AUTH }), testEnv, bgCtx()));
    expect(end.status).toBe(200);
    expect((await bridge().get(b.id))?.status).toBe("released");
  });

  it("the edits still run when the worker is given a context", async () => {
    const a = await permission("f8e");
    calls.length = 0;
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.fetch(new Request(`https://example.com/api/requests/${a.id}/release`, { method: "POST", headers: AUTH }), testEnv, ctx);
    await Promise.all(waits);
    expect(edits()).toHaveLength(1);
  });
});

describe("releases at turn end", () => {
  it("a stop releases the session's pending permission", async () => {
    const mine = await permission("f6a");
    const other = await permission("f6other");
    calls.length = 0;
    await stopViaApi("f6a", { elapsedSeconds: 1 });
    expect((await bridge().get(mine.id))?.status).toBe("released");
    expect((await bridge().get(other.id))?.status).toBe("pending");
    expect(edits()).toHaveLength(1);
    expect(edits()[0].body.content).toMatch(/\nBack at the terminal\.$/);
  });

  it("a new permission does not release the session's other permission", async () => {
    const a = await permission("f6b");
    await permission("f6b");
    expect((await bridge().get(a.id))?.status).toBe("pending");
  });

  it("session end releases the session's pending question", async () => {
    const done = await stop("f6c", { elapsedSeconds: 3600 });
    const q = await question("f6c");
    const p = await permission("f6c");
    const q2 = await question("f6c");
    calls.length = 0;
    const res = await SELF.fetch("https://example.com/api/sessions/f6c/end", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    for (const r of [q, p, q2]) expect((await bridge().get(r.id))?.status).toBe("released");
    expect((await bridge().get(done.id))?.status).toBe("pending");
    expect(edits()).toHaveLength(3);
  });
});

describe("alarm", () => {
  it("a release landing during an alarm edit survives", async () => {
    const a = await permission("f7a");
    const b = await permission("f7b");
    await setRecord(a.id, { expires: Date.now() - 1000 });
    await setRecord(b.id, { expires: Date.now() - 1000 });
    await runInDurableObject(bridge(), async (inst) => {
      const alarm = inst.alarm();
      const releases = Promise.all([inst.release(a.id, CALLER), inst.release(b.id, CALLER)]);
      await Promise.all([alarm, releases]);
    });
    const statuses = [(await bridge().get(a.id))?.status, (await bridge().get(b.id))?.status].sort();
    expect(statuses).toEqual(["expired", "released"]);
  });
});
