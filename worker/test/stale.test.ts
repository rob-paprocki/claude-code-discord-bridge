import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import type { Env } from "../src/env";
import worker from "../src/index";
import { staleRecordUpdate } from "../src/interactions";
import { outcomeLine } from "../src/render";
import { renderJoinState } from "../src/render-join";
import type { JoinRecord, Principal, RequestRecord } from "../src/types";
import { generateKeyPair, publicKeyHex, signedInteraction } from "./helpers/discord";
import { type DiscordCall, stubDiscord } from "./helpers/discordRest";
import { joinMachine, machineAuth } from "./helpers/machine";

const USER = "test-user-id";
// One joined machine per test: AUTH for hook calls, CALLER for direct Durable Object calls.
let AUTH: { Authorization: string };
let CALLER: Principal;
let keyPair: CryptoKeyPair;
let testEnv: Env;
let calls: DiscordCall[];

beforeAll(async () => {
  keyPair = await generateKeyPair();
  testEnv = { ...(env as unknown as Env), DISCORD_PUBLIC_KEY: await publicKeyHex(keyPair) };
});
beforeEach(async () => {
  ({ headers: AUTH, principal: CALLER } = await machineAuth("mac"));
  calls = stubDiscord().calls;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(bridge(), (_i, state) => {
    state.storage.sql.exec("DELETE FROM joins");
    state.storage.sql.exec("DELETE FROM machines");
  });
});

function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
const create = (session: string) => bridge().create({ kind: "permission", machine: "mac", project: "proj", session, tool: "Bash", preview: "ls" }, CALLER);
const patches = () => calls.filter((c) => c.method === "PATCH");

async function interact(body: object): Promise<any> {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} } as unknown as ExecutionContext;
  const res = await worker.fetch(await signedInteraction(body, keyPair), testEnv, ctx);
  return res.json();
}
const press = (customId: string, content = "original text") =>
  interact({ type: 3, user: { id: USER }, message: { id: "m1", channel_id: "dm-channel", content }, data: { custom_id: customId } });
const submit = (customId: string, text: string) =>
  interact({
    type: 5,
    user: { id: USER },
    message: { id: "m1", channel_id: "dm-channel", content: "original text" },
    data: { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: "t", value: text }] }] },
  });
async function setRecord(id: string, patch: Partial<RequestRecord>) {
  await runInDurableObject(bridge(), (_i, state) => {
    const row = state.storage.sql.exec("SELECT json FROM requests WHERE id = ?", id).one();
    state.storage.sql.exec("UPDATE requests SET json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.json as string), ...patch }), id);
  });
}
async function enroll(machine: string): Promise<{ id: string; secret: string }> {
  const res = await SELF.fetch("https://example.com/api/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machine }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; secret: string };
}
const joinRow = async (id: string) =>
  runInDurableObject(bridge(), (_i, state) => JSON.parse(state.storage.sql.exec("SELECT json FROM joins WHERE id = ?", id).one().json as string) as JoinRecord);

describe("old buttons clear the message and show what happened", () => {
  it("stale button press clears the message", async () => {
    const { id } = await create("st-1");
    await press(`b:${id}:allow`);
    const rec = (await bridge().get(id)) as RequestRecord;
    const json = await press(`b:${id}:deny`);
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content.startsWith("original text\n")).toBe(true);
    expect(json.data.content.endsWith(outcomeLine(rec))).toBe(true);
    expect(json.data.content).toContain("Allowed");
    expect(json.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("expired request press clears the message", async () => {
    const { id } = await create("st-2");
    await setRecord(id, { expires: Date.now() - 1000 });
    const json = await press(`b:${id}:allow`);
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content).toMatch(/\nExpired\. Answer in the terminal\.$/);
  });

  it("unknown request press clears the message", async () => {
    const json = await press("b:zzzzz:allow");
    expect(json.type).toBe(7);
    expect(json.data.components).toEqual([]);
    expect(json.data.content).toBe("original text\nNo longer available.");
  });

  it("a stranger is still refused privately", async () => {
    const { id } = await create("st-3");
    await press(`b:${id}:allow`);
    const json = await interact({ type: 3, user: { id: "stranger" }, message: { id: "m1", content: "x" }, data: { custom_id: `b:${id}:deny` } });
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
  });

  it("late modal keeps the typed text", async () => {
    const { id } = await create("st-4");
    await press(`b:${id}:allow`);
    const json = await submit(`m:${id}:answer`, "hello there");
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toBe("Too late: this was already handled. What you typed:\n```\nhello there\n```");
    expect(json.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("late modal text is clipped to 2000 characters and keeps its fence", async () => {
    const { id } = await create("st-5");
    await press(`b:${id}:allow`);
    const json = await submit(`m:${id}:answer`, `${"😀".repeat(1500)}\`\`\`x`);
    expect(json.data.content.length).toBeLessThanOrEqual(2000);
    expect(json.data.content.endsWith("…\n```")).toBe(true);
    expect(json.data.content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(json.data.content.startsWith("Too late: this was already handled. What you typed:\n```\n")).toBe(true);
  });

  // Discord only knows ``` fences and closes the block at the next ```, so backtick runs in the
  // typed text are broken with zero-width spaces (as fenced() does) inside a plain ``` fence.
  it("late modal text cannot close its fence", async () => {
    const { id } = await create("st-5b");
    await press(`b:${id}:allow`);
    for (const typed of ["```", "````", "`````x", "a ``` b ````` c", "`".repeat(1200)]) {
      const json = await submit(`m:${id}:answer`, typed);
      const content: string = json.data.content;
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(content.startsWith("Too late: this was already handled. What you typed:\n```\n")).toBe(true);
      expect(content.endsWith("\n```")).toBe(true);
      // Exactly the opening and the closing fence: no other run of two or more backticks.
      expect(content.split("```").length).toBe(3);
      expect(content.slice(content.indexOf("\n") + 4, -4)).not.toMatch(/``/);
    }
  });

  it("late modal with empty text shows no fence", async () => {
    const { id } = await create("st-6");
    await press(`b:${id}:allow`);
    const json = await submit(`m:${id}:answer`, "");
    expect(json.type).toBe(4);
    expect(json.data.content).toBe("Too late: this was already handled. What you typed:");
  });

  it("a still-pending record is refused privately, not cleared", async () => {
    const { id } = await create("st-7");
    const rec = (await bridge().get(id)) as RequestRecord;
    const res = staleRecordUpdate({ message: { content: "kept" } } as never, rec);
    const json = (await res.json()) as any;
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toBe("Already handled.");
  });

  it("stale join approve shows the join's state", async () => {
    const j = await enroll("stale-join");
    await press(`j:${j.id}:deny`);
    const json = await press(`j:${j.id}:approve`);
    const join = await joinRow(j.id);
    expect(json.type).toBe(7);
    expect(json.data.content).toBe(renderJoinState(join).content);
    expect(json.data.content).toContain("Denied");
    expect(json.data.flags).toBe(4);
    expect(json.data.components).toEqual([]);
  });

  it("stale join press on an unknown join clears the buttons", async () => {
    const json = await press("j:nope:approve", "kept");
    expect(json.type).toBe(7);
    expect(json.data.content).toBe("kept");
    expect(json.data.components).toEqual([]);
  });

  it("stale remove shows Removed", async () => {
    await joinMachine("stale-box");
    const mid = (await runInDurableObject(bridge(), (_i, state) => state.storage.sql.exec("SELECT id FROM machines WHERE id != ?", CALLER.id).one().id)) as string;
    expect((await press(`mc:${mid}:confirm`)).data.content).toContain("Removed");
    for (const action of ["remove", "confirm"]) {
      const json = await press(`mc:${mid}:${action}`);
      expect(json.type).toBe(7);
      expect(json.data.content).toContain("Removed");
      expect(json.data.components).toEqual([]);
      expect(json.data.flags).toBe(4);
    }
  });

  it("a press with an unparseable id stays an ephemeral refusal", async () => {
    const json = await press("garbage");
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
  });
});

describe("late copies", () => {
  // Two allowed users for this Durable Object instance only; the second user's send runs `during`.
  async function withTwoUsers(during: () => Promise<void>, run: () => Promise<void>) {
    vi.restoreAllMocks();
    let fired = false;
    calls = stubDiscord(async (c) => {
      if (c.path === "/users/@me/channels") return Response.json({ id: `dm-${c.body.recipient_id}` });
      if (c.method === "POST" && c.path === "/channels/dm-u2/messages" && !fired) {
        fired = true;
        await during();
      }
      return undefined;
    }).calls;
    const original: string = await (runInDurableObject as any)(bridge(), (inst: any) => {
      const before = inst.env.ALLOWED_USER_IDS as string;
      inst.env = { ...inst.env, ALLOWED_USER_IDS: "test-user-id,u2" };
      return before;
    });
    try {
      await run();
    } finally {
      await (runInDurableObject as any)(bridge(), (inst: any) => {
        inst.env = { ...inst.env, ALLOWED_USER_IDS: original };
      });
    }
  }

  it("late copy of a request is edited", async () => {
    await withTwoUsers(
      async () => {
        await runInDurableObject(bridge(), async (inst, state) => {
          const id = state.storage.sql.exec("SELECT id FROM requests WHERE json LIKE '%late-req%'").one().id as string;
          await (inst as Bridge).answer(id, { behavior: "allow" }, USER);
        });
      },
      async () => {
        const res = await SELF.fetch("https://example.com/api/requests", {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "permission", machine: "mac", project: "proj", session: "late-req", tool: "Bash", preview: "ls" }),
        });
        expect(res.status).toBeLessThan(300);
        await vi.waitFor(() => expect(patches().some((c) => c.path.startsWith("/channels/dm-u2/"))).toBe(true));
        const late = patches().filter((c) => c.path.startsWith("/channels/dm-u2/messages/"));
        expect(late).toHaveLength(1);
        expect(late[0].body.components).toEqual([]);
        expect(late[0].body.content).toMatch(/\nAllowed$/);
      },
    );
  });

  it("late copy of a join is edited", async () => {
    await withTwoUsers(
      async () => {
        await runInDurableObject(bridge(), async (inst, state) => {
          const id = state.storage.sql.exec("SELECT id FROM joins").one().id as string;
          await (inst as Bridge).approveJoin(id, USER);
        });
      },
      async () => {
        await enroll("late-join");
        await vi.waitFor(() => expect(patches().some((c) => c.path.startsWith("/channels/dm-u2/"))).toBe(true));
        const late = patches().filter((c) => c.path.startsWith("/channels/dm-u2/messages/"));
        expect(late).toHaveLength(1);
        expect(late[0].body.content).toContain("Joined");
        expect(late[0].body.components).toEqual([]);
      },
    );
  });

  it("a join approved during the send loop keeps Remove on the pressed copy", async () => {
    let pressed: any;
    let pressedId = "";
    await withTwoUsers(
      async () => {
        const ids = await runInDurableObject(bridge(), (_i, state) => {
          const row = state.storage.sql.exec("SELECT json FROM joins").one();
          return JSON.parse(row.json as string) as { id: string; messageIds: string[] };
        });
        pressedId = ids.messageIds[0];
        const [channel, message] = pressedId.split(":");
        pressed = await interact({
          type: 3,
          user: { id: USER },
          message: { id: message, channel_id: channel, content: "x" },
          data: { custom_id: `j:${ids.id}:approve` },
        });
      },
      async () => {
        await enroll("late-keep");
        await vi.waitFor(() => expect(patches().some((c) => c.path.startsWith("/channels/dm-u2/"))).toBe(true));
        const [channel, message] = pressedId.split(":");
        // The pressed copy is answered by the press itself and keeps its Remove button.
        expect(pressed.type).toBe(7);
        expect(JSON.stringify(pressed.data.components)).toContain("mc:");
        expect(patches().filter((c) => c.path === `/channels/${channel}/messages/${message}`)).toEqual([]);
        const late = patches().filter((c) => c.path.startsWith("/channels/dm-u2/messages/"));
        expect(late).toHaveLength(1);
        expect(late[0].body.content).toContain("Joined");
        expect(late[0].body.components).toEqual([]);
        // A later removal edits both copies.
        const machineId = await runInDurableObject(bridge(), (_i, state) => {
          const row = state.storage.sql.exec("SELECT id FROM machines WHERE id != ?", CALLER.id).one();
          return row.id as string;
        });
        const removed = await bridge().removeMachine(machineId);
        const edited = removed.messageEdits.flatMap((e) => e.messageIds).sort();
        expect(edited).toHaveLength(2);
        expect(edited).toContain(pressedId);
        expect(edited.some((m) => m.startsWith("dm-u2:"))).toBe(true);
      },
    );
  });
});
