import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { resolveConfig } from "../src/setup-row";
import { allowedUserIds } from "../src/users";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { stubDiscord } from "./helpers/discordRest";
import { machineAuth } from "./helpers/machine";
import { clearSetup, seededRow, writeSetup } from "./setup-seed";

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} }) as unknown as ExecutionContext;
// The test bindings carry only the token: every other value comes from the setup row.
const bare = (): Env => ({ ...(env as unknown as Env), DISCORD_PUBLIC_KEY: undefined, DISCORD_APP_ID: undefined, ALLOWED_USER_IDS: undefined });

beforeEach(() => void stubDiscord());
afterEach(() => vi.restoreAllMocks());

describe("resolveConfig", () => {
  it("an override wins over the looked-up value, per field", async () => {
    const row = await seededRow();
    expect(resolveConfig({}, row)).toEqual({ appId: "test-app-id", publicKey: "test-public-key", allowed: ["test-user-id"] });
    expect(resolveConfig({ DISCORD_APP_ID: " a9 " }, row)).toEqual({ appId: "a9", publicKey: "test-public-key", allowed: ["test-user-id"] });
    expect(resolveConfig({ DISCORD_PUBLIC_KEY: "k9" }, row).publicKey).toBe("k9");
    expect(resolveConfig({ ALLOWED_USER_IDS: "u1,u2" }, row).allowed).toEqual(["u1", "u2"]);
    expect(resolveConfig({ DISCORD_APP_ID: "  " }, row).appId).toBe("test-app-id");
  });

  it("no row and no overrides gives nothing", () => {
    expect(resolveConfig({}, null)).toEqual({ appId: null, publicKey: null, allowed: [] });
  });
});

describe("allowedUserIds", () => {
  it('ALLOWED_USER_IDS " a, ,b " gives [a, b]', () => {
    expect(allowedUserIds(" a, ,b ", "owner")).toEqual(["a", "b"]);
  });

  it("no override gives the owner", () => {
    expect(allowedUserIds(undefined, "owner")).toEqual(["owner"]);
    expect(allowedUserIds("   ", "owner")).toEqual(["owner"]);
  });

  it("no override and no owner gives []", () => {
    expect(allowedUserIds(undefined, null)).toEqual([]);
  });
});

describe("interactions read the setup row", () => {
  it("503 before setup", async () => {
    await clearSetup();
    const res = await worker.fetch(await signedInteraction({ type: 1 }, await generateKeyPair()), bare(), ctx());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("setup not finished");
  });

  it("the stored verify key verifies a PING", async () => {
    const keyPair = await generateKeyPair();
    await writeSetup({ ...(await seededRow()), verifyKey: await publicKeyHex(keyPair) });
    const res = await worker.fetch(await signedInteraction({ type: 1 }, keyPair), bare(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
    const wrong = await worker.fetch(await signedInteraction({ type: 1 }, await generateKeyPair()), bare(), ctx());
    expect(wrong.status).toBe(401);
  });

  it("the owner from the row may press, a stranger may not", async () => {
    const keyPair = await generateKeyPair();
    await writeSetup({ ...(await seededRow()), verifyKey: await publicKeyHex(keyPair), ownerId: "owner-9" });
    const command = async (user: string) =>
      (await (
        await worker.fetch(await signedInteraction({ type: 2, user: { id: user }, data: { name: "machines" } }, keyPair), bare(), ctx())
      ).json()) as { data: { content: string } };
    expect((await command("owner-9")).data.content).not.toBe("Only the bridge's owner can answer this.");
    expect((await command("test-user-id")).data.content).toBe("Only the bridge's owner can answer this.");
  });
});

describe("the admin key is gone", () => {
  const request = { kind: "permission", machine: "m", project: "p", session: "s-admin", tool: "Bash", preview: "ls" };

  it("the old admin key is just a wrong key", async () => {
    const res = await SELF.fetch("https://example.com/api/requests", {
      method: "POST",
      headers: { Authorization: "Bearer test-hook-key" },
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/machines/self is 200 or 401, never 409", async () => {
    const self = (headers: Record<string, string>) => SELF.fetch("https://example.com/api/machines/self", { headers });
    expect((await self({})).status).toBe(401);
    expect((await self({ Authorization: "Bearer test-hook-key" })).status).toBe(401);
    const auth = await machineAuth("desk");
    const ok = await self(auth.headers);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: "desk" });
  });

  it("POST /api/admin/register-commands is 404", async () => {
    const auth = await machineAuth();
    const res = await SELF.fetch("https://example.com/api/admin/register-commands", {
      method: "POST",
      headers: auth.headers,
    });
    expect(res.status).toBe(404);
  });
});
