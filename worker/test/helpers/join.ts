import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { Bridge } from "../../src/bridge";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { signedInteraction } from "./discord";

export const USER = "test-user-id";
export type Join = { id: string; secret: string };

export function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

export const enrollRaw = (machine: string) =>
  SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });

export async function enroll(machine = "laptop"): Promise<Join> {
  const res = await enrollRaw(machine);
  expect(res.status).toBe(201);
  return (await res.json()) as Join;
}

export const poll = async (j: Join) =>
  (await (await SELF.fetch(`https://example.com/api/enroll/${j.id}`, { headers: { Authorization: `Bearer ${j.secret}` } })).json()) as {
    status: string;
    key?: string;
  };

export const sqlRows = (sql: string) => runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec(sql).toArray());

// A signed button press from `user` on message `message` in `channel`. The work the Worker defers
// (ctx.waitUntil) is awaited before the response is returned.
export function makePress(keyPair: () => CryptoKeyPair, testEnv: () => Env) {
  return async function press(customId: string, user = USER, channel = "dm1", message = "m1"): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => {})), passThroughOnException() {} } as unknown as ExecutionContext;
    const req = await signedInteraction(
      { type: 3, channel_id: channel, user: { id: user }, message: { id: message, channel_id: channel, content: "x" }, data: { custom_id: customId } },
      keyPair(),
    );
    const res = await worker.fetch(req, testEnv(), ctx);
    await Promise.all(pending);
    return res;
  };
}
