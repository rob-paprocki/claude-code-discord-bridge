import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { NewRequest } from "../src/types";
import { stubDiscord } from "./helpers/discordRest";
import { machineAuth } from "./helpers/machine";

let AUTH: { Authorization: string };

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

function post(body: unknown, headers: Record<string, string> = AUTH) {
  return SELF.fetch("https://example.com/api/requests", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const permission: NewRequest = {
  kind: "permission",
  machine: "mac",
  project: "proj",
  session: "s1",
  tool: "Bash",
  preview: "ls",
};

async function create(r: Partial<NewRequest> = {}): Promise<string> {
  const res = await post({ ...permission, ...r });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("hook api", () => {
  beforeEach(async () => {
    ({ headers: AUTH } = await machineAuth("mac"));
    stubDiscord();
  });
  afterEach(() => vi.restoreAllMocks());

  it("api rejects a missing or wrong key", async () => {
    expect((await post(permission, {})).status).toBe(401);
    expect((await post(permission, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(permission, { Authorization: "test-hook-key" })).status).toBe(401);
    const get = await SELF.fetch("https://example.com/api/requests/abcde");
    expect(get.status).toBe(401);
  });

  it("permission request starts pending", async () => {
    const res = await post(permission);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("pending");
    expect(body.id).toMatch(/^[a-km-z]{5}$/);
    const rec = await bridge().get(body.id);
    expect(rec?.expires).toBe((rec?.created ?? 0) + 24 * 3600 * 1000);
  });

  it("rejects invalid bodies", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...permission, kind: "bogus" })).status).toBe(400);
    expect((await post({ ...permission, project: 5 })).status).toBe(400);
    expect((await post({ kind: "permission" })).status).toBe(400);
    expect((await post([])).status).toBe(400);
  });

  it("poll returns the answer once answered", async () => {
    const id = await create();
    const pending = await SELF.fetch(`https://example.com/api/requests/${id}`, { headers: AUTH });
    expect(await pending.json()).toEqual({ id, status: "pending" });

    expect(await bridge().answer(id, { behavior: "allow" }, "test-user-id")).toBe("ok");
    const res = await SELF.fetch(`https://example.com/api/requests/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "answered", answer: { behavior: "allow" } });
  });

  it("unknown request is 404", async () => {
    const res = await SELF.fetch("https://example.com/api/requests/zzzzz", { headers: AUTH });
    expect(res.status).toBe(404);
    const rel = await SELF.fetch("https://example.com/api/requests/zzzzz/release", {
      method: "POST",
      headers: AUTH,
    });
    expect(rel.status).toBe(404);
  });

  it("release marks released and later answers are stale", async () => {
    const id = await create();
    const rel = await SELF.fetch(`https://example.com/api/requests/${id}/release`, {
      method: "POST",
      headers: AUTH,
    });
    expect(rel.status).toBe(200);
    expect(await rel.json()).toEqual({ status: "released" });
    expect(await bridge().answer(id, { behavior: "allow" }, "test-user-id")).toBe("stale");
    expect((await bridge().get(id))?.status).toBe("released");
  });

  it("answers from users outside the allow list are forbidden, first answer stands", async () => {
    const id = await create();
    expect(await bridge().answer(id, { behavior: "allow" }, "intruder")).toBe("forbidden");
    expect((await bridge().get(id))?.status).toBe("pending");
    expect(await bridge().answer(id, { behavior: "deny" }, "test-user-id")).toBe("ok");
    expect(await bridge().answer(id, { behavior: "allow" }, "test-user-id")).toBe("stale");
    expect((await bridge().get(id))?.answer).toEqual({ behavior: "deny" });
    expect(await bridge().answer("zzzzz", { behavior: "allow" }, "test-user-id")).toBe("stale");
  });

  it("parallel requests stay separate", async () => {
    const a = await create({ session: "s1" });
    const b = await create({ session: "s2" });
    expect(a).not.toBe(b);
    await bridge().answer(a, { behavior: "allow" }, "test-user-id");
    expect((await bridge().get(a))?.status).toBe("answered");
    expect((await bridge().get(b))?.status).toBe("pending");
  });

  describe("optional field types", () => {
    const stored = async (id: string) =>
      runInDurableObject(bridge(), (_i, state) => JSON.parse(state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one().json as string) as Record<string, unknown>);
    const goodQ = { question: "Pick", header: "H", multiSelect: true, options: [{ label: "a", description: "d" }, { label: "b" }] };

    it("drops optional fields of the wrong type", async () => {
      const id = await create({
        kind: "notify",
        title: 123,
        text: { a: 1 },
        tool: ["x"],
        preview: null,
        event: false,
        elapsedSeconds: "5",
        mode: "bogus",
        questions: "nope",
      } as unknown as Partial<NewRequest>);
      const r = await stored(id);
      for (const f of ["title", "text", "tool", "preview", "event", "elapsedSeconds", "mode", "questions"]) expect(r).not.toHaveProperty(f);
    });

    it("drops a negative or non-finite elapsedSeconds and keeps a good one", async () => {
      expect(await stored(await create({ kind: "notify", elapsedSeconds: -1 }))).not.toHaveProperty("elapsedSeconds");
      expect(await stored(await create({ kind: "notify", elapsedSeconds: null as unknown as number }))).not.toHaveProperty("elapsedSeconds");
      expect((await stored(await create({ kind: "notify", elapsedSeconds: 0 }))).elapsedSeconds).toBe(0);
      expect((await stored(await create({ kind: "notify", elapsedSeconds: 12.5 }))).elapsedSeconds).toBe(12.5);
    });

    it("answers 400 for a question request with bad questions", async () => {
      const bad: unknown[] = [
        undefined,
        "nope",
        {},
        [null],
        [{ question: 1, options: [] }],
        [{ question: "q" }],
        [{ question: "q", options: "x" }],
        [{ question: "q", options: [{ label: 1 }] }],
        [{ question: "q", options: [{ label: "a", description: 2 }] }],
        [{ question: "q", header: 3, options: [] }],
        [{ question: "q", multiSelect: "yes", options: [] }],
      ];
      for (const questions of bad) {
        expect((await post({ ...permission, kind: "question", questions })).status).toBe(400);
      }
    });

    it("keeps valid questions unchanged and drops invalid ones on other kinds", async () => {
      const id = await create({ kind: "question", questions: [goodQ] });
      expect((await stored(id)).questions).toEqual([goodQ]);
      expect(await stored(await create({ kind: "permission", questions: [{ question: 1 }] as never }))).not.toHaveProperty("questions");
    });
  });
});
