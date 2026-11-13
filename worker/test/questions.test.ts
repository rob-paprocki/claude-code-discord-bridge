import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { NewRequest } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscord, type DiscordCall } from "./helpers/discordRest";
import { CALLER } from "./helpers/machine";

const USER = "test-user-id";
const CONTENT = "**Question** · mac · proj · s1\n1. Pick one\n2. Pick many";
const QUESTIONS = [
  { question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { question: "Which features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Cache" }, { label: "Logs" }] },
];

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
  const { id } = await bridge().create({ kind: "question", machine: "mac", project: "proj", session: "s1", questions: QUESTIONS, ...r }, CALLER);
  return id;
}

async function send(body: object): Promise<{ status: number; json: any }> {
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(await signedInteraction(body, keyPair), testEnv, ctx);
  const json = res.status === 200 ? await res.json() : undefined;
  await Promise.all(waits);
  return { status: res.status, json };
}

function press(customId: string, extra: object = {}) {
  return send({
    type: 3,
    member: { user: { id: USER } },
    message: { id: "m1", channel_id: "dm-channel", content: CONTENT },
    data: { custom_id: customId, component_type: 2 },
    ...extra,
  });
}

function pick(customId: string, values: string[]) {
  return press(customId, { data: { custom_id: customId, component_type: 3, values } });
}

function flat(json: any): any[] {
  return json.data.components.flatMap((r: any) => r.components);
}

describe("multi-question answers", () => {
  it("answered line follows question order on the press response", async () => {
    const id = await create({ session: "s-order" });
    await pick(`s:${id}:1`, ["0"]);
    const last = await press(`b:${id}:opt:0:1`);
    expect(last.json.data.content.endsWith("Answered: SQLite; Auth")).toBe(true);
  });

  it("two questions need two presses before answered", async () => {
    const id = await create();
    const first = await press(`b:${id}:opt:0:1`);
    expect(first.json.type).toBe(7);
    expect(first.json.data.content).toBe(CONTENT);
    let rec = await bridge().get(id);
    expect(rec?.status).toBe("pending");
    expect(rec?.partial).toEqual({ "Which database?": "SQLite" });
    const chosen = flat(first.json).filter((c) => c.custom_id?.startsWith(`b:${id}:opt:0:`));
    expect(chosen.map((c) => [c.label, c.style])).toEqual([["Postgres", 1], ["✓ SQLite", 3]]);
    expect(flat(first.json).some((c) => c.custom_id === `s:${id}:1`)).toBe(true);
    expect(flat(first.json).some((c) => c.custom_id === `b:${id}:back`)).toBe(true);

    const last = await pick(`s:${id}:1`, ["0", "2"]);
    expect(last.json.type).toBe(7);
    expect(last.json.data.content).toBe(`${CONTENT}\nAnswered: SQLite; Auth, Logs`);
    expect(last.json.data.components).toEqual([]);
    rec = await bridge().get(id);
    expect(rec?.status).toBe("answered");
    expect(rec?.answer).toEqual({ type: "answers", answers: { "Which database?": "SQLite", "Which features?": "Auth, Logs" } });
  });

  it("select menu answer joins labels", async () => {
    const id = await create({ questions: [QUESTIONS[1]] });
    const { json } = await pick(`s:${id}:0`, ["1", "0"]);
    expect(json.data.components).toEqual([]);
    expect((await bridge().get(id))?.answer).toEqual({ type: "answers", answers: { "Which features?": "Auth, Cache" } });
  });

  it("marks the chosen select options as default while pending", async () => {
    const id = await create();
    const { json } = await pick(`s:${id}:1`, ["1"]);
    const menu = flat(json).find((c) => c.custom_id === `s:${id}:1`);
    expect(menu.options.map((o: any) => !!o.default)).toEqual([false, true, false]);
    expect((await bridge().get(id))?.status).toBe("pending");
  });

  it("answers map uses the exact question text as key", async () => {
    const text = "  Which   database?\n(exact) ";
    const id = await create({ questions: [{ question: text, options: [{ label: "A" }] }] });
    await press(`b:${id}:opt:0:0`);
    const rec = await bridge().get(id);
    expect(rec?.answer).toEqual({ type: "answers", answers: { [text]: "A" } });
  });

  it("a later press changes the choice before the last question", async () => {
    const id = await create();
    await press(`b:${id}:opt:0:0`);
    const second = await press(`b:${id}:opt:0:1`);
    expect((await bridge().get(id))?.partial).toEqual({ "Which database?": "SQLite" });
    expect(flat(second.json).find((c) => c.custom_id === `b:${id}:opt:0:0`).label).toBe("Postgres");
    const last = await pick(`s:${id}:1`, ["2"]);
    expect(last.json.data.content).toBe(`${CONTENT}\nAnswered: SQLite; Logs`);
  });

  it("clips the outcome line to 2000 characters", async () => {
    const id = await create({ questions: [{ question: "Q", options: [{ label: "L".repeat(100) }] }] });
    const long = "x".repeat(1990);
    const { json } = await press(`b:${id}:opt:0:0`, { message: { id: "m1", channel_id: "dm-channel", content: long } });
    expect(json.data.content.length).toBeLessThanOrEqual(2000);
  });

  it("bad indexes are Already handled and change nothing", async () => {
    const id = await create();
    for (const [customId, values] of [[`b:${id}:opt:0:9`, []], [`b:${id}:opt:7:0`, []], [`b:${id}:opt:x:y`, []], [`s:${id}:1`, ["9"]], [`s:${id}:1`, ["a"]], [`s:${id}:1`, []], [`s:${id}:5`, ["0"]]] as [string, string[]][]) {
      const { status, json } = await pick(customId, values);
      expect(status).toBe(200);
      expect(json.type).toBe(4);
      expect(json.data.content).toBe("Already handled.");
    }
    expect((await bridge().get(id))?.partial).toBeUndefined();
  });

  it("refuses strangers, answered and expired requests", async () => {
    const id = await create();
    const stranger = await press(`b:${id}:opt:0:0`, { member: { user: { id: "stranger" } } });
    expect(stranger.json.data.content).toBe("Only the bridge's owner can answer this.");
    expect((await bridge().get(id))?.partial).toBeUndefined();
    await runInDurableObject(bridge(), (_i, state) => {
      const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one();
      const rec = { ...JSON.parse(row.json as string), expires: Date.now() - 1 };
      state.storage.sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify(rec), id);
    });
    const late = await press(`b:${id}:opt:0:0`);
    expect(late.json.type).toBe(7);
    expect(late.json.data.content).toMatch(/\nExpired\. Answer in the terminal\.$/);
    const id2 = await create({ questions: [QUESTIONS[0]] });
    await press(`b:${id2}:opt:0:0`);
    const again = await press(`b:${id2}:opt:0:1`);
    expect(again.json.type).toBe(7);
    expect(again.json.data.components).toEqual([]);
    expect(again.json.data.content).toMatch(/\nAnswered/);
  });

  it("edits the other copies when the last question is answered", async () => {
    const id = await create({ questions: [QUESTIONS[0]] });
    await runInDurableObject(bridge(), (_i, state) => {
      const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one();
      const rec = { ...JSON.parse(row.json as string), messageIds: ["dm-channel:m1", "other-channel:m9"] };
      state.storage.sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify(rec), id);
    });
    calls.length = 0;
    await press(`b:${id}:opt:0:0`);
    const edits = calls.filter((c) => c.method === "PATCH");
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe("/channels/other-channel/messages/m9");
  });
});

describe("Answer… guards", () => {
  it("a stranger pressing Answer… gets the owner-only refusal, not a modal", async () => {
    const id = await create();
    const { json } = await press(`b:${id}:answer`, { member: { user: { id: "stranger" } } });
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toBe("Only the bridge's owner can answer this.");
  });

  it("Answer… on an already answered request is Already handled, not a modal", async () => {
    const id = await create({ questions: [QUESTIONS[0]] });
    await press(`b:${id}:opt:0:0`);
    const { json } = await press(`b:${id}:answer`);
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content).toMatch(/\nAnswered/);
  });
});
