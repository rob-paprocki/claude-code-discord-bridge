import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../src/discord/verify";
import type { Env } from "../src/env";
import worker from "../src/index";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";

let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let pk: string;
let testEnv: Env;

beforeAll(async () => {
  keyPair = await generateKeyPair();
  otherPair = await generateKeyPair();
  pk = await publicKeyHex(keyPair);
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: pk };
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (req: Request) => worker.fetch(req, testEnv, ctx);

describe("verifyDiscordRequest", () => {
  it("accepts a valid signature and returns the body", async () => {
    const req = await signedInteraction({ type: 1 }, keyPair);
    expect(await verifyDiscordRequest(req, pk)).toEqual({ ok: true, body: '{"type":1}' });
  });

  it("rejects a signature from another key", async () => {
    const req = await signedInteraction({ type: 1 }, otherPair);
    expect(await verifyDiscordRequest(req, pk)).toEqual({ ok: false });
  });

  it("rejects a tampered body", async () => {
    const good = await signedInteraction({ type: 1 }, keyPair);
    const req = new Request(good.url, { method: "POST", headers: good.headers, body: '{"type":2}' });
    expect(await verifyDiscordRequest(req, pk)).toEqual({ ok: false });
  });

  it("rejects missing headers", async () => {
    const req = new Request("https://example.com/discord/interactions", { method: "POST", body: "{}" });
    expect(await verifyDiscordRequest(req, pk)).toEqual({ ok: false });
  });

  it("rejects malformed hex and a malformed public key", async () => {
    const good = await signedInteraction({ type: 1 }, keyPair);
    const badSig = new Request(good.url, {
      method: "POST",
      headers: { "X-Signature-Ed25519": "zz", "X-Signature-Timestamp": "1" },
      body: "{}",
    });
    expect(await verifyDiscordRequest(badSig, pk)).toEqual({ ok: false });
    expect(await verifyDiscordRequest(await signedInteraction({ type: 1 }, keyPair), "test-public-key")).toEqual({
      ok: false,
    });
  });
});

describe("POST /discord/interactions", () => {
  it("valid PING gets type 1", async () => {
    const res = await post(await signedInteraction({ type: 1 }, keyPair));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("bad signature gets 401", async () => {
    const res = await post(await signedInteraction({ type: 1 }, otherPair));
    expect(res.status).toBe(401);
  });

  it("missing headers get 401", async () => {
    const res = await post(
      new Request("https://example.com/discord/interactions", { method: "POST", body: '{"type":1}' }),
    );
    expect(res.status).toBe(401);
  });

  it("unsupported interaction types get 400", async () => {
    const res = await post(await signedInteraction({ type: 4 }, keyPair));
    expect(res.status).toBe(400);
  });

  it("only accepts POST", async () => {
    const res = await post(new Request("https://example.com/discord/interactions"));
    expect(res.status).toBe(404);
  });
});
