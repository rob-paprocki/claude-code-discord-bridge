import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { withTimeout } from "../src/setup-routes";
import type { SetupRow } from "../src/setup-row";
import { stubDiscordApp } from "./helpers/discordRest";
import { seededRow, writeSetup } from "./setup-seed";

const ORIGIN = "https://example.com";
const HERE = `${ORIGIN}/discord/interactions`;
const bare = (over: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  DISCORD_PUBLIC_KEY: undefined,
  DISCORD_APP_ID: undefined,
  ALLOWED_USER_IDS: undefined,
  ...over,
});
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} }) as unknown as ExecutionContext;
async function page(path = "/", method = "GET", e: Env = bare()): Promise<{ status: number; type: string | null; html: string }> {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), e, ctx());
  return { status: res.status, type: res.headers.get("Content-Type"), html: await res.text() };
}
async function seed(over: Partial<SetupRow> = {}): Promise<SetupRow> {
  const row = { ...(await seededRow()), ...over };
  await writeSetup(row);
  return row;
}

afterEach(() => vi.restoreAllMocks());

describe("status page", () => {
  it("all green shows the next step", async () => {
    stubDiscordApp();
    await seed({ botName: "Bridge Bot" });
    const p = await page();
    expect(p.status).toBe(200);
    expect(p.type).toBe("text/html; charset=utf-8");
    expect(p.html).toContain("Run the installer on each machine.");
    expect(p.html).toContain("Bridge Bot");
    expect(p.html).toContain("✅");
    expect(p.html).not.toContain("❌");
  });

  it("never shows IDs, keys or the owner", async () => {
    const app = { id: "111222333", verify_key: "a1b2c3", owner: { id: "999888777" }, interactions_endpoint_url: HERE };
    stubDiscordApp({ app });
    await seed({ appId: "111222333", verifyKey: "a1b2c3", ownerId: "999888777", lookedUp: 0 });
    const pages = [await page(), await page("/setup/test-dm", "POST"), await page("/setup/move", "POST")];
    for (const p of pages) {
      expect(p.status).toBe(200);
      for (const secret of ["111222333", "a1b2c3", "999888777", "test-token"]) expect(p.html).not.toContain(secret);
    }
  });

  it("elsewhere shows the host and the Move form", async () => {
    const other = "https://other.example/discord/interactions";
    const { calls } = stubDiscordApp({ app: { interactions_endpoint_url: other } });
    await seed({ interactionsUrl: other });
    const p = await page();
    expect(p.html).toContain("other.example");
    expect(p.html).toContain('action="/setup/move"');
    expect(p.html).toContain("⚠️");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("here hides the Move form", async () => {
    stubDiscordApp();
    await seed();
    expect((await page()).html).not.toContain('action="/setup/move"');
  });

  it("errors: bad token", async () => {
    stubDiscordApp({ status: { get: 401 } });
    await seed({ error: { step: "lookup", kind: "token", messages: [] } });
    const p = await page();
    expect(p.html).toContain(
      "The bot token isn't valid. Copy it again from the Discord Developer Portal → Bot → Reset Token, and update <code>DISCORD_BOT_TOKEN</code>.",
    );
    expect(p.html).toContain("❌");
  });

  it("errors: Discord down", async () => {
    stubDiscordApp({ status: { get: 503 } });
    await seed({ error: { step: "lookup", kind: "unreachable", messages: [] } });
    expect((await page()).html).toContain("Discord didn't answer; try again in a minute.");
  });

  it("errors: URL rejected shows Discord's reason", async () => {
    const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "Could not <verify> it." }] } };
    stubDiscordApp({ status: { patch: { status: 400, body: { code: 50035, errors } } } });
    await seed({ interactionsUrl: null });
    const p = await page();
    expect(p.html).toContain("Could not &lt;verify&gt; it.");
    expect(p.html).toContain("the Worker could not answer Discord's check: open this page again in a minute");
    // The common cause on a fresh deploy: the address sits behind Cloudflare Access.
    expect(p.html).toContain(
      "If this address is behind Cloudflare Access (some accounts protect every <code>workers.dev</code> address), Discord can't reach it: add a custom domain to the Worker and open this page there.",
    );
  });

  it("errors: no owner", async () => {
    stubDiscordApp({ app: { team: {}, interactions_endpoint_url: HERE } });
    await seed({ ownerId: null, lookedUp: 0 });
    const p = await page();
    expect(p.html).toContain("Owner not found: set <code>ALLOWED_USER_IDS</code> to your Discord user ID.");
    expect(p.html).not.toContain("Run the installer on each machine.");
  });

  it("ALLOWED_USER_IDS stands in for a missing owner", async () => {
    stubDiscordApp({ app: { team: {}, interactions_endpoint_url: HERE } });
    await seed({ ownerId: null });
    expect((await page("/", "GET", bare({ ALLOWED_USER_IDS: "u1" }))).html).toContain("Run the installer on each machine.");
  });

  it("errors: a set value that disagrees with Discord", async () => {
    stubDiscordApp();
    await seed();
    const p = await page("/", "GET", bare({ DISCORD_PUBLIC_KEY: "ff".repeat(32), DISCORD_APP_ID: "other-app" }));
    expect(p.html).toContain("<code>DISCORD_PUBLIC_KEY</code> doesn't match the key Discord reports; button presses will fail.");
    expect(p.html).toContain("<code>DISCORD_APP_ID</code> doesn't match the application Discord reports; <code>/machines</code> can't be registered.");
  });

  it("values set by you are marked, by name only", async () => {
    stubDiscordApp();
    await seed();
    const plain = await page();
    expect(plain.html).not.toContain("Set by you");
    const set = await page("/", "GET", bare({ ALLOWED_USER_IDS: "424242", DISCORD_APP_ID: "test-app-id" }));
    expect(set.html).toContain("Set by you: <code>ALLOWED_USER_IDS</code>, <code>DISCORD_APP_ID</code>");
    expect(set.html).not.toContain("424242");
  });

  it("a failing setup is not re-run on every page load", async () => {
    const { calls } = stubDiscordApp({ status: { get: 401 } });
    await seed({ error: { step: "lookup", kind: "token", messages: [] }, nextTry: 0 });
    for (let n = 0; n < 5; n++) await page();
    expect(calls.filter((c) => c.method === "GET" && c.path === "/applications/@me")).toHaveLength(1);
  });

  it("HTML is escaped", async () => {
    stubDiscordApp({ app: { bot: { username: "<b>x</b>" } } });
    await seed({ botName: "<b>x</b>" });
    const p = await page();
    expect(p.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(p.html).not.toContain("<b>x</b>");
  });

  it("no script tag", async () => {
    stubDiscordApp();
    await seed();
    expect((await page()).html).not.toContain("<script");
  });

  it("other paths are still 404", async () => {
    expect((await page("/nope")).status).toBe(404);
    expect((await page("/", "PUT")).status).toBe(404);
  });

  it("withTimeout gives up after the wait", async () => {
    expect(await withTimeout(Promise.resolve(1), 50)).toEqual({ done: true, value: 1 });
    expect(await withTimeout(new Promise<number>(() => {}), 10)).toEqual({ done: false });
  });
});

describe("test DM", () => {
  it("test DM sent", async () => {
    const { calls } = stubDiscordApp();
    await seed();
    const p = await page("/setup/test-dm", "POST");
    expect(p.html).toContain("Test DM sent. Check your Discord DMs.");
    const sent = calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-channel/messages");
    expect(sent).toHaveLength(1);
    expect(sent[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  it("test DM refused", async () => {
    stubDiscordApp({ status: { send: { status: 403, body: { code: 50278, message: "Cannot send messages to this user" } } } });
    await seed();
    const p = await page("/setup/test-dm", "POST");
    expect(p.html).toContain(
      "The bot can't DM you yet. Share a server with it (any server, even a private one of your own) and allow DMs from server members.",
    );
  });

  it("test DM limited", async () => {
    const { calls } = stubDiscordApp();
    await seed();
    await page("/setup/test-dm", "POST");
    const before = calls.length;
    const p = await page("/setup/test-dm", "POST");
    expect(p.html).toContain("Wait a minute before trying again.");
    expect(calls.length).toBe(before);
  });

  it("test DM with no owner", async () => {
    stubDiscordApp({ app: { team: {}, interactions_endpoint_url: HERE } });
    await seed({ ownerId: null });
    expect((await page("/setup/test-dm", "POST")).html).toContain("Owner not found");
  });
});
