import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { type DiscordCall, stubDiscordApp } from "./helpers/discordRest";
import { bridge } from "./helpers/join";
import { seededRow, writeSetup } from "./setup-seed";

const ORIGIN = "https://example.com";
const HERE = `${ORIGIN}/discord/interactions`;
const OTHER = "https://other.example/discord/interactions";
const bare = (): Env => ({ ...(env as unknown as Env), DISCORD_PUBLIC_KEY: undefined, DISCORD_APP_ID: undefined, ALLOWED_USER_IDS: undefined });

let calls: DiscordCall[];

// A request through the Worker; the work it hands to waitUntil (DM edits) is awaited too.
async function fetchPage(path: string, init: RequestInit = {}): Promise<{ status: number; html: string }> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), bare(), ctx);
  const html = await res.text();
  await Promise.all(pending);
  return { status: res.status, html };
}
const form = (fields: Record<string, string>): RequestInit => ({ method: "POST", body: new URLSearchParams(fields) });
const appPatches = () => calls.filter((c) => c.method === "PATCH" && c.path === "/applications/@me");
const dmEdits = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/"));

// Asks for a move and returns the link from the DM.
async function requestMove(): Promise<{ id: string; k: string; path: string }> {
  const p = await fetchPage("/setup/move", { method: "POST" });
  expect(p.html).toContain("Check your Discord DMs");
  const sent = calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-channel/messages");
  expect(sent).toHaveLength(1);
  expect(sent[0].body.content).toBe(
    "Move the bridge's Discord buttons to `https://example.com`?\nThe link works for 10 minutes. Ignore it to keep the buttons where they are.",
  );
  expect(sent[0].body.flags).toBe(4);
  expect(sent[0].body.allowed_mentions).toEqual({ parse: [] });
  const button = sent[0].body.components[0].components[0];
  expect(button.style).toBe(5);
  const url = new URL(button.url);
  expect(url.origin).toBe(ORIGIN);
  const id = url.pathname.split("/").pop()!;
  return { id, k: url.searchParams.get("k")!, path: `${url.pathname}${url.search}` };
}

beforeEach(async () => {
  calls = stubDiscordApp({ app: { interactions_endpoint_url: OTHER } }).calls;
  await writeSetup({ ...(await seededRow()), interactionsUrl: OTHER });
});
afterEach(() => vi.restoreAllMocks());

describe("moving the buttons here", () => {
  it("the link opens a page that asks first", async () => {
    const link = await requestMove();
    const p = await fetchPage(link.path);
    expect(p.status).toBe(200);
    expect(p.html).toContain(`action="/setup/move/${link.id}"`);
    expect(p.html).toContain("https://example.com");
    // Opening the link (or a link preview fetching it) moves nothing.
    expect(appPatches()).toHaveLength(0);
  });

  it("move: confirming PATCHes", async () => {
    const link = await requestMove();
    const p = await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "move" }));
    expect(p.html).toContain("Moved: Discord now sends button presses here.");
    expect(appPatches()).toHaveLength(1);
    expect(appPatches()[0].body).toEqual({ interactions_endpoint_url: HERE });
    expect((await bridge().setupRow())?.interactionsUrl).toBe(HERE);
    expect(dmEdits()).toHaveLength(1);
    expect(dmEdits()[0].body.content).toBe("**Moved** · `https://example.com`");
    expect(dmEdits()[0].body.components).toEqual([]);
  });

  it("keep leaves the URL", async () => {
    const link = await requestMove();
    const p = await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "keep" }));
    expect(p.html).toContain("Not moved.");
    expect(appPatches()).toHaveLength(0);
    expect((await bridge().setupRow())?.interactionsUrl).toBe(OTHER);
    expect(dmEdits()[0].body.content).toBe("**Not moved**");
  });

  it("the link works only with its secret, and only once", async () => {
    const link = await requestMove();
    const wrong = await fetchPage(`/setup/move/${link.id}`, form({ k: "0".repeat(link.k.length), choice: "move" }));
    expect(wrong.status).toBe(404);
    expect(wrong.html).toContain("This link has expired or was already used.");
    expect((await fetchPage(`/setup/move/${link.id}?k=nope`)).status).toBe(404);
    expect(appPatches()).toHaveLength(0);
    await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "move" }));
    const again = await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "move" }));
    expect(again.status).toBe(404);
    expect(appPatches()).toHaveLength(1);
  });

  it("expiry leaves the URL", async () => {
    const link = await requestMove();
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 10 * 60 * 1000 + 1000);
    await runDurableObjectAlarm(bridge());
    expect(appPatches()).toHaveLength(0);
    expect(dmEdits().map((c) => c.body.content)).toEqual(["**Not moved** (expired)"]);
    expect((await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "move" }))).status).toBe(404);
    expect(appPatches()).toHaveLength(0);
  });

  it("one at a time", async () => {
    await requestMove();
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 2 * 60 * 1000);
    const p = await fetchPage("/setup/move", { method: "POST" });
    expect(p.html).toContain("Wait a minute before trying again.");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-channel/messages")).toHaveLength(1);
  });

  it("not offered when the URL already points here", async () => {
    await writeSetup({ ...(await seededRow()), interactionsUrl: HERE });
    vi.restoreAllMocks();
    calls = stubDiscordApp({ app: { interactions_endpoint_url: HERE } }).calls;
    const p = await fetchPage("/setup/move", { method: "POST" });
    expect(p.html).toContain("The buttons already point here.");
    expect(calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(0);
  });

  it("a refused PATCH shows Discord's reason", async () => {
    const link = await requestMove();
    vi.restoreAllMocks();
    const errors = { interactions_endpoint_url: { _errors: [{ code: "X", message: "Could not verify." }] } };
    calls = stubDiscordApp({ app: { interactions_endpoint_url: OTHER }, status: { patch: { status: 400, body: { code: 50035, errors } } } }).calls;
    const p = await fetchPage(`/setup/move/${link.id}`, form({ k: link.k, choice: "move" }));
    expect(p.html).toContain("Discord refused the address: Could not verify.");
    expect((await bridge().setupRow())?.interactionsUrl).toBe(OTHER);
    expect(dmEdits()[0].body.content).toBe("**Not moved**: Discord refused the address. Could not verify.");
  });

  it("the secret is never stored", async () => {
    const link = await requestMove();
    const rows = await runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec("SELECT json FROM setup").toArray());
    expect(JSON.stringify(rows)).not.toContain(link.k);
  });
});
