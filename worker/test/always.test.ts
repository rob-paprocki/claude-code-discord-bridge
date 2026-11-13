import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import { renderRequest } from "../src/render";
import type { NewRequest, RequestRecord } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscord } from "./helpers/discordRest";
import { CALLER, machineAuth } from "./helpers/machine";

// "Always allow" and "Switch to auto mode": the terminal dialog's options 2 and 3, in Discord.
const USER = "test-user-id";
const CONTENT = "**Needs your OK: Bash** · mac · proj · s1";
const ALWAYS = 'Bash(echo "permission test"); access to /tmp';

let keyPair: CryptoKeyPair;
let testEnv: Env;

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
beforeEach(() => void stubDiscord());
afterEach(() => vi.restoreAllMocks());

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
async function create(r: Partial<NewRequest> = {}): Promise<string> {
  const { id } = await bridge().create({ kind: "permission", machine: "mac", project: "proj", session: "s1", tool: "Bash", preview: "ls", ...r }, CALLER);
  return id;
}
async function press(customId: string): Promise<any> {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const body = { type: 3, member: { user: { id: USER } }, message: { id: "m1", channel_id: "dm-channel", content: CONTENT }, data: { custom_id: customId, component_type: 2 } };
  const res = await worker.fetch(await signedInteraction(body, keyPair), testEnv, ctx);
  const json = await res.json();
  await Promise.all(waits);
  return json;
}
const ids = (m: { components?: object[] }) =>
  (JSON.stringify(m.components ?? []).match(/"custom_id":"[^"]+"/g) ?? []).map((s) => s.slice(13, -1));
const labels = (m: { components?: object[] }) =>
  (JSON.stringify(m.components ?? []).match(/"label":"[^"]+"/g) ?? []).map((s) => s.slice(9, -1));

function rec(r: Partial<RequestRecord> = {}): RequestRecord {
  return { id: "abcde", kind: "permission", machine: "mac", project: "proj", session: "s1", tool: "Bash", preview: "ls", status: "pending", created: 0, expires: 1, messageIds: [], ...r };
}

describe("permission choices", () => {
  it("without suggestions: Allow, Switch to auto mode, Deny, Back to terminal", () => {
    const [m] = renderRequest(rec());
    expect(ids(m)).toEqual(["b:abcde:allow", "b:abcde:auto", "b:abcde:deny", "b:abcde:back"]);
    expect(labels(m)).toEqual(["Allow", "Switch to auto mode", "Deny", "Back to terminal"]);
    expect(m.content).not.toContain("Always allow");
  });

  it("with suggestions: an Always allow button and a line saying what it covers", () => {
    const [m] = renderRequest(rec({ always: ALWAYS }));
    expect(ids(m)).toEqual(["b:abcde:allow", "b:abcde:always", "b:abcde:auto", "b:abcde:deny", "b:abcde:back"]);
    expect(labels(m)[1]).toBe("Always allow");
    expect(m.content).toContain("Always allow will: Bash\\(echo \"permission test\"\\); access to /tmp");
  });

  it("the covers line is escaped and cut", () => {
    const [m] = renderRequest(rec({ always: `<@123> **x** ${"y".repeat(400)}` }));
    const line = m.content.split("\n").find((l) => l.startsWith("Always allow will: "))!;
    expect(line).toContain("\\<\\@123\\>");
    expect(line).toContain("\\*\\*x\\*\\*");
    expect(line.length).toBeLessThanOrEqual("Always allow will: ".length + 320);
  });

  it("Always allow answers allow, with scope always", async () => {
    const id = await create({ always: ALWAYS });
    const res = await press(`b:${id}:always`);
    expect(res.type).toBe(7);
    expect(res.data.content).toMatch(/\nAllowed, and won't ask again$/);
    expect(res.data.components).toEqual([]);
    expect((await bridge().poll(id, CALLER))?.answer).toEqual({ behavior: "allow", scope: "always" });
  });

  it("Always allow on a prompt without suggestions does nothing", async () => {
    const id = await create();
    const res = await press(`b:${id}:always`);
    expect(res.data.flags).toBe(64);
    expect((await bridge().poll(id, CALLER))?.status).toBe("pending");
  });

  it("Switch to auto mode answers allow, with scope auto", async () => {
    const id = await create();
    const res = await press(`b:${id}:auto`);
    expect(res.data.content).toMatch(/\nAllowed, and switched to auto mode$/);
    expect((await bridge().poll(id, CALLER))?.answer).toEqual({ behavior: "allow", scope: "auto" });
  });

  it("a plain Allow still has no scope", async () => {
    const id = await create({ always: ALWAYS });
    await press(`b:${id}:allow`);
    expect((await bridge().poll(id, CALLER))?.answer).toEqual({ behavior: "allow" });
  });

  it("the hook API keeps a string always and drops anything else", async () => {
    const auth = await machineAuth("mac");
    const post = async (always: unknown) => {
      const res = await SELF.fetch("https://example.com/api/requests", {
        method: "POST",
        headers: auth.headers,
        body: JSON.stringify({ kind: "permission", machine: "mac", project: "p", session: `s-${Math.random()}`, tool: "Bash", preview: "ls", always }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    expect((await bridge().get(await post(ALWAYS)))?.always).toBe(ALWAYS);
    expect((await bridge().get(await post({ rules: [] })))).not.toHaveProperty("always");
  });
});

describe("questions as a one-way notice (BRIDGE_QUESTIONS=notify)", () => {
  it("shows the questions and where to answer, with no buttons", () => {
    const questions = [{ question: "Which *one*?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "the second" }] }];
    const [m] = renderRequest({ ...rec(), kind: "notify", event: "AskUserQuestion", tool: undefined, preview: undefined, questions, text: undefined });
    expect(m.content.split("\n")[0]).toBe("**Claude is asking** · mac · proj · s1");
    expect(m.content).toContain("1. Pick: Which \\*one\\*?");
    expect(m.content).toContain("• B (the second)");
    expect(m.content).toMatch(/\nAnswer in the terminal or the Claude app\.$/);
    expect(m.components).toBeUndefined();
  });
});
