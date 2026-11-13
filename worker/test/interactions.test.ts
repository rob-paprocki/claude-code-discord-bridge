import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { NewRequest, RequestRecord } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscord, type DiscordCall } from "./helpers/discordRest";
import { CALLER } from "./helpers/machine";

const USER = "test-user-id";
const CONTENT = "**Needs your OK: Bash** · mac · proj · s1\n```\nls\n```";

let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];
let waits: Promise<unknown>[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});

beforeEach(() => {
  calls = stubDiscord().calls;
  waits = [];
});
afterEach(() => vi.restoreAllMocks());

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

async function create(r: Partial<NewRequest> = {}): Promise<string> {
  const { id } = await bridge().create({ kind: "permission", machine: "mac", project: "proj", session: "s1", tool: "Bash", preview: "ls", ...r }, CALLER);
  return id;
}

async function send(body: object): Promise<{ status: number; json: any }> {
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(await signedInteraction(body, keyPair), testEnv, ctx);
  const json = res.status === 200 ? await res.json() : undefined;
  await Promise.all(waits);
  return { status: res.status, json };
}

function press(customId: string, extra: object = {}, content = CONTENT) {
  return send({
    type: 3,
    member: { user: { id: USER } },
    message: { id: "m1", channel_id: "dm-channel", content },
    data: { custom_id: customId, component_type: 2 },
    ...extra,
  });
}

function submit(customId: string, text: string, userId = USER) {
  return send({
    type: 5,
    user: { id: userId },
    message: { id: "m1", channel_id: "dm-channel", content: CONTENT },
    data: { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: text }] }] },
  });
}

async function setRecord(id: string, patch: Partial<RequestRecord>) {
  await runInDurableObject(bridge(), (_i, state) => {
    const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one();
    const rec = { ...JSON.parse(row.json as string), ...patch };
    state.storage.sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify(rec), id);
  });
}

describe("interactions", () => {
  it("Allow answers a permission request", async () => {
    const id = await create();
    const { status, json } = await press(`b:${id}:allow`);
    expect(status).toBe(200);
    expect(json.type).toBe(7);
    expect(json.data.content).toBe(`${CONTENT}\nAllowed`);
    expect(json.data.components).toEqual([]);
    expect(json.data.allowed_mentions).toEqual({ parse: [] });
    const rec = await bridge().get(id);
    expect(rec?.status).toBe("answered");
    expect(rec?.answer).toEqual({ behavior: "allow" });
  });

  it("Deny answers", async () => {
    const id = await create();
    const { json } = await press(`b:${id}:deny`);
    expect(json.type).toBe(7);
    expect(json.data.content).toBe(`${CONTENT}\nDenied`);
    expect((await bridge().get(id))?.answer).toEqual({ behavior: "deny" });
  });

  it("Back releases with answer {type: back}", async () => {
    const id = await create();
    const { json } = await press(`b:${id}:back`);
    expect(json.type).toBe(7);
    expect(json.data.content).toBe(`${CONTENT}\nBack to terminal`);
    const rec = await bridge().get(id);
    expect(rec?.status).toBe("released");
    expect(rec?.answer).toEqual({ type: "back" });
  });

  it("Answer opens a modal and modal submit stores {type: text}", async () => {
    const id = await create({ kind: "question", questions: [{ question: "Pick", options: [{ label: "A" }] }] });
    const { json } = await press(`b:${id}:answer`);
    expect(json.type).toBe(9);
    expect(json.data.custom_id).toBe(`m:${id}:answer`);
    expect(json.data.components[0].components).toEqual([
      { type: 4, custom_id: "t", label: "Answer", style: 2, required: true, max_length: 4000 },
    ]);
    expect((await bridge().get(id))?.status).toBe("pending");
    const done = await submit(`m:${id}:answer`, "use B");
    expect(done.json.type).toBe(7);
    expect(done.json.data.content).toBe(`${CONTENT}\nAnswered: use B`);
    const rec = await bridge().get(id);
    expect(rec?.status).toBe("answered");
    expect(rec?.answer).toEqual({ type: "text", text: "use B" });
  });

  it("Chat modal stores {type: chat}", async () => {
    const id = await create({ kind: "question", questions: [{ question: "Pick", options: [{ label: "A" }] }] });
    expect((await press(`b:${id}:chat`)).json.data.custom_id).toBe(`m:${id}:chat`);
    const done = await submit(`m:${id}:chat`, "let's talk");
    expect(done.json.type).toBe(7);
    expect((await bridge().get(id))?.answer).toEqual({ type: "chat", text: "let's talk" });
  });

  it("Reply modal stores {type: text}", async () => {
    const id = await create({ kind: "stop", elapsedSeconds: 3600, text: "hi" });
    await setRecord(id, { status: "pending" });
    expect((await press(`b:${id}:reply`)).json.data.custom_id).toBe(`m:${id}:reply`);
    await submit(`m:${id}:reply`, "go on");
    expect((await bridge().get(id))?.answer).toEqual({ type: "text", text: "go on" });
  });

  it("second press is refused", async () => {
    const id = await create();
    await press(`b:${id}:allow`);
    const { json } = await press(`b:${id}:deny`);
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content).toMatch(/\nAllowed$/);
    expect((await bridge().get(id))?.answer).toEqual({ behavior: "allow" });
  });

  it("stranger cannot answer", async () => {
    const id = await create();
    const { json } = await press(`b:${id}:allow`, { member: { user: { id: "stranger" } } });
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toBe("Only the bridge's owner can answer this.");
    expect((await bridge().get(id))?.status).toBe("pending");
    const sub = await submit(`m:${id}:answer`, "x", "stranger");
    expect(sub.json.type).toBe(4);
    expect((await bridge().get(id))?.status).toBe("pending");
  });

  it("expired request is refused and marked expired", async () => {
    const id = await create();
    await setRecord(id, { expires: Date.now() - 1000 });
    const { json } = await press(`b:${id}:allow`);
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content).toMatch(/\nExpired\. Answer in the terminal\.$/);
    const rec = await bridge().get(id);
    expect(rec?.status).toBe("expired");
    expect(rec?.answer).toBeUndefined();
    const again = await press(`b:${id}:allow`);
    expect(again.json.data.content).toMatch(/\nExpired\. Answer in the terminal\.$/);
  });

  it("malformed ids get an ephemeral Already handled", async () => {
    for (const customId of ["garbage", "b::allow", "b:abcde", "m:abcde:nope"]) {
      const { status, json } = await press(customId);
      expect(status).toBe(200);
      expect(json.type).toBe(4);
      expect(json.data.content).toBe("Already handled.");
    }
  });

  it("keeps the updated message within 2000 characters", async () => {
    const id = await create();
    const long = "x".repeat(1950);
    const { json } = await press(`b:${id}:allow`, {}, long);
    expect(json.data.content.startsWith(`${long}\n`)).toBe(true);
    expect(json.data.content.length).toBeLessThanOrEqual(2000);
    const id2 = await create();
    const sub = await send({
      type: 5,
      user: { id: USER },
      message: { id: "m1", channel_id: "dm-channel", content: long },
      data: { custom_id: `m:${id2}:answer`, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: "y".repeat(500) }] }] },
    });
    expect(sub.json.data.content.length).toBe(2000);
    expect(sub.json.data.content.startsWith(`${long}\nAnswered: yyy`)).toBe(true);
    expect(sub.json.data.content.endsWith("…")).toBe(true);
  });

  it("edits the other users' messages so no live buttons remain", async () => {
    const id = await create();
    await setRecord(id, { messageIds: ["dm-channel:m1", "other-channel:m8", "other-channel:m9"] });
    calls.length = 0;
    await press(`b:${id}:allow`);
    const edits = calls.filter((c) => c.method === "PATCH");
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe("/channels/other-channel/messages/m9");
    expect(edits[0].body.components).toEqual([]);
    expect(edits[0].body.content).toContain("Allowed");
    expect(edits[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("a refused press edits nothing", async () => {
    const id = await create();
    await setRecord(id, { messageIds: ["dm-channel:m1", "other-channel:m9"] });
    calls.length = 0;
    await press(`b:${id}:allow`, { member: { user: { id: "stranger" } } });
    expect(calls).toHaveLength(0);
  });
});
