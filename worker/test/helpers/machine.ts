import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { Bridge } from "../../src/bridge";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { randomHex, sha256Hex } from "../../src/keys";
import type { MachineRecord, Principal } from "../../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./discord";

// Joins a machine end to end (enroll, Approve press, poll) and returns its id and key.
// Discord must already be stubbed (stubDiscord) and ALLOWED_USER_IDS must hold `userId`.
export async function joinMachine(name: string, userId = "test-user-id"): Promise<{ key: string; joinId: string }> {
  const res = await SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine: name }),
  });
  if (res.status !== 201) throw new Error(`enroll failed: ${res.status}`);
  const join = (await res.json()) as { id: string; secret: string };
  const keyPair = await generateKeyPair();
  const testEnv: Env = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
  const press = await signedInteraction(
    {
      type: 3,
      channel_id: "dm1",
      user: { id: userId },
      message: { id: "m1", channel_id: "dm1", content: "x" },
      data: { custom_id: `j:${join.id}:approve` },
    },
    keyPair,
  );
  await worker.fetch(press, testEnv, ctx);
  const polled = await SELF.fetch(`https://example.com/api/enroll/${join.id}`, {
    headers: { Authorization: `Bearer ${join.secret}` },
  });
  const { key } = (await polled.json()) as { key?: string };
  if (!key) throw new Error("no key delivered");
  return { key, joinId: join.id };
}

// A joined machine without the join: an active machine row holding the hash of a fresh key.
// `headers` authenticates hook calls; `principal` is the same caller for direct Durable Object calls.
export async function machineAuth(name = "laptop"): Promise<{ headers: { Authorization: string }; principal: Principal }> {
  const key = randomHex(32);
  const id = randomHex(16);
  const m: MachineRecord = { id, name, keyHash: await sha256Hex(key), status: "active", joined: Date.now(), lastSeen: null, messageIds: [] };
  const stub = env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec("INSERT INTO machines (id, key_hash, json) VALUES (?, ?, ?)", id, m.keyHash, JSON.stringify(m));
  });
  return { headers: { Authorization: `Bearer ${key}` }, principal: { kind: "machine", id, name } };
}

// A caller for direct Durable Object calls that never go through a key. Requests it creates carry
// its name, so it is named like the requests the older tests build.
export const CALLER: Principal = { kind: "machine", id: "c".repeat(32), name: "mac" };
