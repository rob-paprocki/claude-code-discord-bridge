import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACHINES_COMMAND } from "../src/discord/rest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { commandsHash, resolveConfig } from "../src/setup-row";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscordApp } from "./helpers/discordRest";
import { bridge } from "./helpers/join";
import { clearSetup, seededRow, writeSetup } from "./setup-seed";

const ORIGIN = "https://example.com";
const HERE = `${ORIGIN}/discord/interactions`;
const MINUTE = 60 * 1000;
const bare = (): Env => ({ ...(env as unknown as Env), DISCORD_PUBLIC_KEY: undefined, DISCORD_APP_ID: undefined, ALLOWED_USER_IDS: undefined });
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} }) as unknown as ExecutionContext;
const route = (c: { method: string; path: string }) => `${c.method} ${c.path}`;
const gets = (calls: { method: string; path: string }[]) => calls.filter((c) => route(c) === "GET /applications/@me").length;

// A promise the test resolves when it chooses.
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

beforeEach(async () => {
  await clearSetup();
});
afterEach(() => vi.restoreAllMocks());

describe("the setup engine", () => {
  it("fresh deploy: lookup, PATCH, register, in that order", async () => {
    const { calls } = stubDiscordApp();
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(calls.map(route)).toEqual(["GET /applications/@me", "PATCH /applications/@me", "POST /applications/a1/commands"]);
    expect(calls[1].body).toEqual({ interactions_endpoint_url: HERE });
    expect(calls[2].body).toEqual(MACHINES_COMMAND);
    expect(row).toMatchObject({ appId: "a1", verifyKey: "00".repeat(32), ownerId: "test-user-id", botName: "Bridge Bot", interactionsUrl: HERE, error: null });
    expect(row.commandsHash).toBe(await commandsHash());
    expect(await bridge().setupRow()).toEqual(row);
  });

  it("the PING during the PATCH verifies", async () => {
    const keyPair = await generateKeyPair();
    const { calls } = stubDiscordApp({
      app: { verify_key: await publicKeyHex(keyPair) },
      // Discord saves the URL only if the Worker answers its signed PING.
      onPatch: async () => {
        const res = await worker.fetch(await signedInteraction({ type: 1 }, keyPair), bare(), ctx());
        const ok = res.status === 200 && ((await res.json()) as { type?: number }).type === 1;
        if (ok) return undefined;
        const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "could not be verified" }] } };
        return Response.json({ code: 50035, message: "Invalid Form Body", errors }, { status: 400 });
      },
    });
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(row.error).toBeNull();
    expect(row.interactionsUrl).toBe(HERE);
    expect(calls.map(route)).toContain("POST /applications/a1/commands");
  });

  it("a URL pointing elsewhere is never overwritten", async () => {
    const other = "https://other.example/discord/interactions";
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: other } });
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(calls.map(route)).not.toContain("PATCH /applications/@me");
    expect(row.interactionsUrl).toBe(other);
    expect(row.error).toBeNull();
  });

  it("a URL already pointing here: no PATCH", async () => {
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: HERE } });
    await bridge().ensureSetup(ORIGIN, { force: false });
    expect(calls.map(route)).toEqual(["GET /applications/@me", "POST /applications/a1/commands"]);
  });

  it("commands registered once, again only after the hash changes", async () => {
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: HERE } });
    const posts = () => calls.filter((c) => route(c) === "POST /applications/a1/commands").length;
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    await bridge().ensureSetup(ORIGIN, { force: false });
    expect(posts()).toBe(1);
    await writeSetup({ ...row, commandsHash: "stale" });
    await bridge().ensureSetup(ORIGIN, { force: false });
    expect(posts()).toBe(2);
  });

  it("commands go to DISCORD_APP_ID when it is set", async () => {
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: HERE } });
    await (runInDurableObject as any)(bridge(), async (inst: any) => {
      const before = inst.env;
      inst.env = { ...before, DISCORD_APP_ID: "a-override" };
      try {
        await inst.ensureSetup(ORIGIN, { force: false });
      } finally {
        inst.env = before;
      }
    });
    expect(calls.map(route)).toContain("POST /applications/a-override/commands");
  });

  it("team owner", async () => {
    stubDiscordApp({ app: { team: { owner_user_id: "u9" }, owner: { id: "team-pseudo" } } });
    expect((await bridge().ensureSetup(ORIGIN, { force: false })).ownerId).toBe("u9");
    await clearSetup();
    vi.restoreAllMocks();
    stubDiscordApp({ app: { team: {}, owner: { id: "team-pseudo" } } });
    expect((await bridge().ensureSetup(ORIGIN, { force: false })).ownerId).toBeNull();
  });

  it("the bot name falls back to /users/@me", async () => {
    const { calls } = stubDiscordApp({ app: { bot: undefined, interactions_endpoint_url: HERE } });
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(calls.map(route)).toContain("GET /users/@me");
    expect(row.botName).toBe("Bridge Bot");
  });

  it("token change re-looks-up", async () => {
    const g = gate();
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: HERE }, onGet: () => g.wait });
    await writeSetup({ ...(await seededRow()), tokenHash: "old", verifyKey: "11".repeat(32) });
    const run = bridge().autoSetup(ORIGIN);
    await vi.waitFor(() => expect(gets(calls)).toBe(1));
    // Until Discord answers, the old values stay in use.
    expect(resolveConfig({}, await bridge().setupRow()).publicKey).toBe("11".repeat(32));
    g.open();
    await run;
    const row = await bridge().setupRow();
    expect(row?.verifyKey).toBe("00".repeat(32));
    expect(row?.appId).toBe("a1");
  });

  it("bad token", async () => {
    stubDiscordApp({ status: { get: 401 } });
    const before = Date.now();
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(row.error).toEqual({ step: "lookup", kind: "token", messages: [] });
    expect(row.nextTry).toBeGreaterThanOrEqual(before + MINUTE);
    expect(row.nextTry).toBeLessThanOrEqual(Date.now() + MINUTE);
  });

  it("Discord down", async () => {
    stubDiscordApp({ status: { get: 503 } });
    expect((await bridge().ensureSetup(ORIGIN, { force: false })).error).toMatchObject({ step: "lookup", kind: "unreachable" });
  });

  it("no answer at all counts as Discord down", async () => {
    stubDiscordApp({ onGet: () => Promise.reject(new TypeError("network down")) });
    expect((await bridge().ensureSetup(ORIGIN, { force: false })).error).toMatchObject({ step: "lookup", kind: "unreachable" });
  });

  it("URL rejected", async () => {
    const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "The specified interactions endpoint url could not be verified." }] } };
    const { calls } = stubDiscordApp({ status: { patch: { status: 400, body: { code: 50035, message: "Invalid Form Body", errors } } } });
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(row.error).toEqual({ step: "url", kind: "rejected", messages: ["The specified interactions endpoint url could not be verified."] });
    expect(row.interactionsUrl).toBeNull();
    expect(calls.map(route)).not.toContain("POST /applications/a1/commands");
  });

  it("a failed registration is recorded", async () => {
    stubDiscordApp({ app: { interactions_endpoint_url: HERE }, status: { commands: 403 } });
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(row.error).toMatchObject({ step: "commands", kind: "other" });
    expect(row.commandsHash).toBeNull();
  });

  it("success clears an earlier error", async () => {
    stubDiscordApp({ status: { get: 503 } });
    const t0 = Date.now();
    await bridge().ensureSetup(ORIGIN, { force: false });
    vi.restoreAllMocks();
    stubDiscordApp();
    vi.spyOn(Date, "now").mockReturnValue(t0 + MINUTE + 1000);
    expect((await bridge().ensureSetup(ORIGIN, { force: false })).error).toBeNull();
  });

  it("retry at most once a minute", async () => {
    const { calls } = stubDiscordApp({ status: { get: 503 } });
    const t0 = Date.now();
    await bridge().autoSetup(ORIGIN);
    expect(gets(calls)).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(t0 + 1000);
    await bridge().autoSetup(ORIGIN);
    expect(gets(calls)).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(t0 + MINUTE + 1000);
    await bridge().autoSetup(ORIGIN);
    expect(gets(calls)).toBe(2);
  });

  it("single flight", async () => {
    const { calls } = stubDiscordApp();
    const [a, b] = await Promise.all([bridge().ensureSetup(ORIGIN, { force: false }), bridge().ensureSetup(ORIGIN, { force: false })]);
    expect(gets(calls)).toBe(1);
    expect(a).toEqual(b);
  });

  it("force looks up again, but at most once a minute", async () => {
    const { calls } = stubDiscordApp();
    const t0 = Date.now();
    await bridge().ensureSetup(ORIGIN, { force: false });
    await bridge().ensureSetup(ORIGIN, { force: true });
    expect(gets(calls)).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(t0 + MINUTE + 1000);
    await bridge().ensureSetup(ORIGIN, { force: true });
    expect(gets(calls)).toBe(2);
  });

  it("a complete row makes autoSetup do nothing", async () => {
    const { calls } = stubDiscordApp();
    await writeSetup(await seededRow());
    await bridge().autoSetup(ORIGIN);
    expect(calls).toHaveLength(0);
  });

  it("stale row: a 25-hour-old lookedUp triggers a lookup on autoSetup", async () => {
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: HERE } });
    await writeSetup({ ...(await seededRow()), lookedUp: Date.now() - 25 * 60 * MINUTE });
    await bridge().autoSetup(ORIGIN);
    expect(gets(calls)).toBe(1);
  });

  it("a change made while a run waits on Discord is kept", async () => {
    const g = gate();
    const { calls } = stubDiscordApp({ onPatch: async () => (await g.wait, undefined) });
    const run = bridge().ensureSetup(ORIGIN, { force: false });
    await vi.waitFor(() => expect(calls.map(route)).toContain("PATCH /applications/@me"));
    expect(await bridge().testDm()).toBe("sent");
    g.open();
    await run;
    expect((await bridge().setupRow())?.lastTestDm).toBeGreaterThan(0);
  });

  it("a failing setup is retried at most once a minute, even when forced", async () => {
    const { calls } = stubDiscordApp({ status: { get: 401 } });
    const t0 = Date.now();
    await bridge().ensureSetup(ORIGIN, { force: true });
    await bridge().ensureSetup(ORIGIN, { force: true });
    await bridge().ensureSetup(ORIGIN, { force: false });
    expect(gets(calls)).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(t0 + MINUTE + 1000);
    await bridge().ensureSetup(ORIGIN, { force: true });
    expect(gets(calls)).toBe(2);
  });

  it("a rejected PATCH is retried at most once a minute, even when forced", async () => {
    const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "no" }] } };
    const { calls } = stubDiscordApp({ status: { patch: { status: 400, body: { code: 50035, errors } } } });
    await bridge().ensureSetup(ORIGIN, { force: true });
    await bridge().ensureSetup(ORIGIN, { force: true });
    expect(calls.filter((c) => route(c) === "PATCH /applications/@me")).toHaveLength(1);
  });

  it("a new token is tried at once, even within the minute", async () => {
    const { calls } = stubDiscordApp({ status: { get: 401 } });
    await bridge().ensureSetup(ORIGIN, { force: false });
    await writeSetup({ ...(await bridge().setupRow())!, tokenHash: "an-older-token" });
    await bridge().ensureSetup(ORIGIN, { force: false });
    expect(gets(calls)).toBe(2);
  });

  it("a URL set by hand after a failed PATCH is not overwritten", async () => {
    const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "no" }] } };
    const stub = stubDiscordApp({ status: { patch: { status: 400, body: { code: 50035, errors } } } });
    const t0 = Date.now();
    await bridge().ensureSetup(ORIGIN, { force: false });
    // Meanwhile the owner sets the URL in the Developer Portal; Discord now accepts PATCHes too.
    vi.restoreAllMocks();
    const other = "https://other.example/discord/interactions";
    const { calls } = stubDiscordApp({ app: { ...stub.app, interactions_endpoint_url: other } });
    vi.spyOn(Date, "now").mockReturnValue(t0 + MINUTE + 1000);
    const row = await bridge().ensureSetup(ORIGIN, { force: false });
    expect(calls.map(route)).not.toContain("PATCH /applications/@me");
    expect(row.interactionsUrl).toBe(other);
  });

  it("the token is never stored", async () => {
    stubDiscordApp();
    await bridge().ensureSetup(ORIGIN, { force: false });
    const rows = await runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec("SELECT json FROM setup").toArray());
    expect(JSON.stringify(rows)).not.toContain("test-token");
  });
});

describe("the automatic run", () => {
  it("a request starts the setup", async () => {
    const { calls } = stubDiscordApp();
    const res = await SELF.fetch(`${ORIGIN}/api/requests/abcde`);
    expect(res.status).toBe(401);
    await vi.waitFor(async () => expect((await bridge().setupRow())?.commandsHash).toBe(await commandsHash()));
    expect(calls.map(route)).toEqual(["GET /applications/@me", "PATCH /applications/@me", "POST /applications/a1/commands"]);
  });

  it("/health does not start it", async () => {
    const { calls } = stubDiscordApp();
    expect(await (await SELF.fetch(`${ORIGIN}/health`)).text()).toBe("ok");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
  });

  it("a join on a fresh deploy waits for the owner instead of failing", async () => {
    const g = gate();
    const { calls } = stubDiscordApp({ onGet: () => g.wait });
    const pending = SELF.fetch(`${ORIGIN}/api/enroll`, { method: "POST", body: JSON.stringify({ machine: "laptop" }) });
    await vi.waitFor(() => expect(gets(calls)).toBe(1));
    // The lookup answers a moment after the join came in.
    setTimeout(() => g.open(), 100);
    const res = await pending;
    expect(res.status).toBe(201);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-channel/messages")).toHaveLength(1);
    await bridge().ensureSetup(ORIGIN, { force: false });
  });

  it("a join with no owner at all still fails, without waiting the full time", async () => {
    stubDiscordApp({ app: { team: {} } });
    const t0 = Date.now();
    const res = await SELF.fetch(`${ORIGIN}/api/enroll`, { method: "POST", body: JSON.stringify({ machine: "laptop" }) });
    expect(res.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("the automatic run never delays a response", async () => {
    const g = gate();
    const { calls } = stubDiscordApp({ onPatch: async () => (await g.wait, undefined) });
    const enroll = await SELF.fetch(`${ORIGIN}/api/enroll`, { method: "POST", body: JSON.stringify({ machine: "laptop" }) });
    expect(enroll.status).toBe(201);
    await vi.waitFor(() => expect(calls.map(route)).toContain("PATCH /applications/@me"));
    // The PATCH is still waiting, and the hook's request was answered all the same.
    const poll = await SELF.fetch(`${ORIGIN}/api/requests/abcde`);
    expect(poll.status).toBe(401);
    g.open();
    await bridge().ensureSetup(ORIGIN, { force: false });
  });
});
