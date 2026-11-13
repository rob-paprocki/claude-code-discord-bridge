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
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});

beforeEach(async () => {
  ({ headers: AUTH, principal: CALLER } = await machineAuth("mac"));
  calls = stubDiscord().calls;
});
afterEach(() => vi.restoreAllMocks());

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

const base = { machine: "mac", project: "proj" };

function stop(session: string, r: Partial<NewRequest> = {}) {
  return bridge().create({ kind: "stop", ...base, session, text: "all done", ...r }, CALLER);
}

function permission(session: string) {
  return bridge().create({ kind: "permission", ...base, session, tool: "Bash", preview: "ls" }, CALLER);
}

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

function press(customId: string) {
  return send({
    type: 3,
    member: { user: { id: USER } },
    message: { id: "m1", channel_id: "dm-channel", content: "x" },
    data: { custom_id: customId, component_type: 2 },
  });
}

function submit(customId: string, text: string) {
  return send({
    type: 5,
    user: { id: USER },
    message: { id: "m1", channel_id: "dm-channel", content: "x" },
    data: { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: text }] }] },
  });
}

describe("stops, conversation mode and expiry", () => {
  it("short stop outside conversation is none", async () => {
    const res = await stop("sa", { elapsedSeconds: 30 });
    expect(res).toMatchObject({ status: "none", mode: "none" });
    expect(calls).toHaveLength(0);
    const rec = await bridge().get(res.id);
    expect(rec?.mode).toBe("none");
    expect(rec?.status).toBe("none");
  });

  it("long stop is done with a 2-hour window", async () => {
    const res = await stop("sb", { elapsedSeconds: 6 * 60 });
    expect(res).toMatchObject({ status: "pending", mode: "done" });
    const rec = await bridge().get(res.id);
    expect(rec?.mode).toBe("done");
    expect(rec?.expires).toBe((rec?.created ?? 0) + 2 * HOUR);
    const msg = calls.find((c) => c.path.endsWith("/messages"))?.body;
    expect(msg.content).toContain("Done after 6m 00s");
    expect(JSON.stringify(msg.components)).toContain(`b:${res.id}:reply`);
  });

  it("stop in conversation is a turn", async () => {
    const first = await permission("sc");
    await bridge().answer(first.id, { type: "chat", text: "hello" }, USER);
    calls.length = 0;
    const res = await stop("sc", { elapsedSeconds: 5, text: "the full reply" });
    expect(res).toMatchObject({ status: "pending", mode: "turn" });
    const rec = await bridge().get(res.id);
    expect(rec?.expires).toBe((rec?.created ?? 0) + DAY);
    const msg = calls.find((c) => c.path.endsWith("/messages"))?.body;
    expect(msg.content).toContain("Claude replied");
    expect(msg.content).toContain("the full reply");
    expect(JSON.stringify(msg.components)).toContain(`b:${res.id}:reply`);
  });

  it("back ends conversation mode", async () => {
    const a = await permission("sd");
    await bridge().answer(a.id, { type: "text", text: "hi" }, USER);
    const turn = await stop("sd", { elapsedSeconds: 1 });
    expect(turn.mode).toBe("turn");
    expect(await bridge().back(turn.id, USER)).toBe("ok");
    expect((await stop("sd", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("release ends conversation mode", async () => {
    const a = await permission("se");
    await bridge().answer(a.id, { type: "chat", text: "hi" }, USER);
    const b = await permission("se");
    await SELF.fetch(`https://example.com/api/requests/${b.id}/release`, { method: "POST", headers: AUTH });
    expect((await stop("se", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("expired turn ends conversation mode", async () => {
    const a = await permission("se3");
    await bridge().answer(a.id, { type: "text", text: "hi" }, USER);
    const turn = await stop("se3", { elapsedSeconds: 1 });
    expect(turn.mode).toBe("turn");
    await setRecord(turn.id, { expires: Date.now() - 1000 });
    expect((await bridge().get(turn.id))?.status).toBe("expired");
    expect((await stop("se3", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("alarm expiry of a turn ends conversation mode", async () => {
    const a = await permission("se4");
    await bridge().answer(a.id, { type: "text", text: "hi" }, USER);
    const turn = await stop("se4", { elapsedSeconds: 1 });
    await setRecord(turn.id, { expires: Date.now() - 1000 });
    await runDurableObjectAlarm(bridge());
    expect((await stop("se4", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("session end turns conversation mode off", async () => {
    const a = await permission("se5");
    await bridge().answer(a.id, { type: "text", text: "hi" }, USER);
    const res = await SELF.fetch("https://example.com/api/sessions/se5/end", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: "se5", conversation: false });
    expect((await stop("se5", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("session end needs the hook key", async () => {
    const res = await SELF.fetch("https://example.com/api/sessions/se6/end", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("session end validates method and session", async () => {
    const get = await SELF.fetch("https://example.com/api/sessions/se6/end", { headers: AUTH });
    expect(get.status).toBe(404);
    const long = await SELF.fetch(`https://example.com/api/sessions/${"x".repeat(201)}/end`, { method: "POST", headers: AUTH });
    expect(long.status).toBe(400);
    const empty = await SELF.fetch("https://example.com/api/sessions//end", { method: "POST", headers: AUTH });
    expect(empty.status).toBe(400);
  });

  it("text answer starts conversation mode", async () => {
    const a = await permission("sf");
    await bridge().answer(a.id, { type: "text", text: "hi" }, USER);
    expect((await stop("sf", { elapsedSeconds: 1 })).mode).toBe("turn");
  });

  it("allow does not start conversation mode", async () => {
    const a = await permission("sg");
    await bridge().answer(a.id, { behavior: "allow" }, USER);
    expect((await stop("sg", { elapsedSeconds: 1 })).mode).toBe("none");
  });

  it("reply on a done DM is accepted", async () => {
    const res = await stop("sh", { elapsedSeconds: 3600 });
    expect(res.mode).toBe("done");
    expect((await press(`b:${res.id}:reply`)).data.custom_id).toBe(`m:${res.id}:reply`);
    await submit(`m:${res.id}:reply`, "go on");
    const got = await SELF.fetch(`https://example.com/api/requests/${res.id}`, { headers: AUTH });
    expect(await got.json()).toEqual({ id: res.id, status: "answered", answer: { type: "text", text: "go on" } });
  });

  it("GET reports expired past expires", async () => {
    const a = await permission("si");
    await setRecord(a.id, { expires: Date.now() - 1000 });
    const got = await SELF.fetch(`https://example.com/api/requests/${a.id}`, { headers: AUTH });
    expect(await got.json()).toEqual({ id: a.id, status: "expired" });
    await runInDurableObject(bridge(), (_i, state) => {
      const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", a.id).one();
      expect(JSON.parse(row.json as string).status).toBe("expired");
    });
  });

  it("alarm expires overdue requests and edits the DM", async () => {
    const a = await permission("sj");
    const fresh = await permission("sj");
    await setRecord(a.id, { expires: Date.now() - 1000 });
    calls.length = 0;
    await runDurableObjectAlarm(bridge());
    expect((await bridge().get(a.id))?.status).toBe("expired");
    expect((await bridge().get(fresh.id))?.status).toBe("pending");
    const [channelId, messageId] = ((await bridge().get(a.id))?.messageIds.at(-1) ?? "").split(":");
    const edits = calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${channelId}/messages/${messageId}`);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].body.content).toContain("Expired. Answer in the terminal.");
    expect(edits[0].body.components).toEqual([]);
    // The alarm is rescheduled while another request is pending.
    expect(await runInDurableObject(bridge(), (_i, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it("alarm deletes records older than 7 days", async () => {
    const a = await permission("sk");
    const b = await permission("sk");
    await setRecord(a.id, { created: Date.now() - 8 * DAY, expires: Date.now() - 7 * DAY, status: "answered" });
    await runDurableObjectAlarm(bridge());
    expect(await bridge().get(a.id)).toBeNull();
    expect((await bridge().get(b.id))?.status).toBe("pending");
  });

  it("notify sends and returns sent", async () => {
    const res = await bridge().create({ kind: "notify", ...base, session: "sl", text: "build finished" }, CALLER);
    expect(res).toMatchObject({ status: "sent" });
    const msg = calls.find((c) => c.path.endsWith("/messages"))?.body;
    expect(msg.content).toContain("build finished");
    expect(msg.components).toBeUndefined();
    expect((await bridge().get(res.id))?.status).toBe("sent");
  });
});
