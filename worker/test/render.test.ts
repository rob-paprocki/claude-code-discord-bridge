import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/bridge";
import { editMessage, sendMessage } from "../src/discord/rest";
import { renderOutcome, renderRequest } from "../src/render";
import type { Principal, RequestRecord } from "../src/types";
import { stubDiscord } from "./helpers/discordRest";
import { machineAuth } from "./helpers/machine";

afterEach(() => vi.restoreAllMocks());

function rec(over: Partial<RequestRecord>): RequestRecord {
  return {
    kind: "permission",
    machine: "mac",
    project: "proj",
    session: "abcdefgh-1234",
    id: "abcde",
    status: "pending",
    created: 0,
    expires: 1,
    messageIds: [],
    ...over,
  };
}

const ids = (m: { components?: object[] }) =>
  JSON.stringify(m.components ?? []).match(/"custom_id":"[^"]+"/g)?.map((s) => s.slice(13, -1));

// One joined machine per test: AUTH for hook calls, CALLER for direct Durable Object calls.
let AUTH: { Authorization: string };
let CALLER: Principal;
beforeEach(async () => {
  ({ headers: AUTH, principal: CALLER } = await machineAuth("mac"));
});
const PERM = { kind: "permission", machine: "mac", project: "proj", session: "s1", tool: "Bash", preview: "ls" };
function bridge(): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}
function post(body: object) {
  return SELF.fetch("https://example.com/api/requests", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

describe("render", () => {
  it("permission DM has Allow, Switch to auto mode, Deny and Back to terminal", () => {
    const [m] = renderRequest(rec({ tool: "Bash", preview: "ls -la", title: "My title" }));
    expect(m.content.split("\n")[0]).toBe("**Needs your OK: Bash** · mac · proj · My title");
    expect(ids(m)).toEqual(["b:abcde:allow", "b:abcde:auto", "b:abcde:deny", "b:abcde:back"]);
  });

  it("first line falls back to the first 8 characters of the session", () => {
    const [m] = renderRequest(rec({ tool: "Bash" }));
    expect(m.content.split("\n")[0]).toBe("**Needs your OK: Bash** · mac · proj · abcdefgh");
  });

  it("single question renders one button per option plus Answer, Chat and Back", () => {
    const [m] = renderRequest(
      rec({ kind: "question", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }),
    );
    expect(m.content.split("\n")[0]).toBe("**Question** · mac · proj · abcdefgh");
    expect(ids(m)).toEqual(["b:abcde:opt:0:0", "b:abcde:opt:0:1", "b:abcde:answer", "b:abcde:chat", "b:abcde:back"]);
  });

  it("multiSelect question renders a select menu with max_values = option count", () => {
    const [m] = renderRequest(
      rec({
        kind: "question",
        questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }],
      }),
    );
    const menu = (m.components![0] as any).components[0];
    expect(menu).toMatchObject({ type: 3, custom_id: "s:abcde:0", min_values: 1, max_values: 3 });
    expect(menu.options.map((o: any) => o.value)).toEqual(["0", "1", "2"]);
  });

  it("four questions fit in five rows", () => {
    const q = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };
    const [m] = renderRequest(rec({ kind: "question", questions: [q, { ...q, multiSelect: true }, q, q] }));
    expect(m.components).toHaveLength(5);
    expect(ids({ components: [m.components![4]] })).toEqual(["b:abcde:answer", "b:abcde:chat", "b:abcde:back"]);
    const more = renderRequest(rec({ kind: "question", questions: [q, q, q, q, q, q] }));
    expect(more[0].components).toHaveLength(5);
  });

  it("long reply is split", () => {
    const text = "x".repeat(4500);
    const parts = renderRequest(rec({ kind: "stop", mode: "turn", text }));
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(2000);
    expect(parts[0].components).toBeUndefined();
    expect(parts[1].components).toBeUndefined();
    expect(ids(parts[2])).toEqual(["b:abcde:reply", "b:abcde:back"]);
  });

  it("split prefers the last newline before 1990 characters", () => {
    const text = `${"a".repeat(1500)}\n${"b".repeat(1000)}`;
    const parts = renderRequest(rec({ kind: "stop", mode: "turn", text }));
    expect(parts).toHaveLength(2);
    expect(parts[0].content.endsWith("a".repeat(1500))).toBe(true);
    expect(parts[1].content).toBe("b".repeat(1000));
  });

  it("backticks in a preview cannot close the fence", () => {
    const preview = "echo ```` && echo `x`\n```";
    const [m] = renderRequest(rec({ tool: "Bash", preview }));
    const lines = m.content.split("\n");
    expect(lines[1]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    const inside = lines.slice(2, -1).join("\n");
    expect(inside).not.toContain("```");
    expect(inside).not.toMatch(/``/);
    expect(inside.replace(/\u200b/g, "")).toBe(preview);
  });

  it("a cut preview says so", () => {
    const [m] = renderRequest(rec({ tool: "Bash", preview: "x".repeat(1500) }));
    expect(m.content).toContain("⚠ Preview cut at 1200 of 1500 characters; the full command is in the terminal.");
    expect(m.content).not.toContain("x".repeat(1201));
    const [whole] = renderRequest(rec({ tool: "Bash", preview: "x".repeat(1200) }));
    expect(whole.content).not.toContain("Preview cut");
  });

  it("a very long reply is capped at three parts with a cut line", () => {
    const parts = renderRequest(rec({ kind: "stop", mode: "turn", text: "word ".repeat(4000) }));
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(2000);
    expect(parts[2].content.endsWith("… (cut; the full reply is in the terminal)")).toBe(true);
    expect(ids(parts[2])).toEqual(["b:abcde:reply", "b:abcde:back"]);
    const notify = renderRequest(rec({ kind: "notify", text: "y".repeat(20000) }));
    expect(notify).toHaveLength(3);
    expect(notify[2].content.endsWith("… (cut; the full reply is in the terminal)")).toBe(true);
  });

  it("the cut keeps code fences balanced and surrogate pairs whole", () => {
    const fenceCount = (s: string) => s.split("\n").filter((l) => /^\s*```/.test(l)).length;
    const cutLine = "… (cut; the full reply is in the terminal)";
    const code = `\`\`\`ts\n${"c".repeat(7000)}\n\`\`\``;
    const parts = renderRequest(rec({ kind: "stop", mode: "turn", text: code }));
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect(p.content.length).toBeLessThanOrEqual(2000);
      expect(fenceCount(p.content) % 2).toBe(0);
    }
    expect(parts[2].content.endsWith(`\`\`\`\n${cutLine}`)).toBe(true);
    for (const pad of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const emoji = renderRequest(rec({ kind: "notify", text: `${"x".repeat(pad)}${"😀".repeat(5000)}` }));
      const last = emoji[2].content;
      expect(/[\ud800-\udbff]\n/.test(last)).toBe(false);
      expect(/(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(last)).toBe(false);
    }
  });

  it("four questions with long descriptions keep every label and description", () => {
    const questions = [0, 1, 2, 3].map((q) => ({
      question: `Question number ${q}?`,
      options: [0, 1, 2, 3].map((o) => ({ label: `Option ${q}-${o}`, description: `${q}${o}`.repeat(100) })),
    }));
    const parts = renderRequest(rec({ kind: "question", questions }));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(2000);
    for (const p of parts.slice(0, -1)) expect(p.components).toBeUndefined();
    expect(parts.at(-1)?.components).toBeDefined();
    const text = parts.map((p) => p.content).join("\n");
    for (let q = 0; q < 4; q++) {
      expect(text).toContain(`Question number ${q}?`);
      for (let o = 0; o < 4; o++) {
        expect(text).toContain(`Option ${q}-${o}`);
        expect(text).toContain(`${q}${o}`.repeat(100));
      }
    }
  });

  it("user-supplied names cannot inject Markdown into the first line", () => {
    const [m] = renderRequest(
      rec({ tool: "**x**", machine: "[a](http://example.com)", project: "_p_\n# h", title: "<@123> `c` @everyone" }),
    );
    const first = m.content.split("\n")[0];
    expect(m.content.split("\n")).toHaveLength(1);
    expect(first).toBe(
      "**Needs your OK: \\*\\*x\\*\\*** · \\[a\\]\\(http://example.com\\) · \\_p\\_ \\# h · \\<\\@123\\> \\`c\\` \\@everyone",
    );
  });

  it("Done after formats minutes and seconds", () => {
    const [m] = renderRequest(rec({ kind: "stop", mode: "done", elapsedSeconds: 125, text: "ok" }));
    expect(m.content.split("\n")[0]).toBe("**Done after 2m 05s** · mac · proj · abcdefgh");
    expect(ids(m)).toEqual(["b:abcde:reply"]);
  });

  it("notify kinds have no components", () => {
    const labels = [
      [{ event: "StopFailure" }, "**Stopped by an error (StopFailure)**"],
      [{ event: "PermissionDenied", tool: "Bash" }, "**Auto mode blocked Bash**"],
      [{ event: "Notification" }, "**A background session needs input**"],
    ] as const;
    for (const [over, first] of labels) {
      const [m] = renderRequest(rec({ kind: "notify", text: "hi", ...over }));
      expect(m.content.startsWith(first)).toBe(true);
      expect(m.components).toBeUndefined();
    }
  });

  it("outcome keeps the body, adds the result and drops buttons", () => {
    const base = rec({ tool: "Bash", preview: "ls", status: "answered", answer: { behavior: "allow" } });
    expect(renderOutcome(base)).toEqual({ content: "**Needs your OK: Bash** · mac · proj · abcdefgh\n```\nls\n```\nAllowed" });
    expect(renderOutcome({ ...base, answer: { behavior: "deny" } }).content).toMatch(/\nDenied$/);
    expect(renderOutcome({ ...base, answer: { type: "back" } }).content).toMatch(/\nBack to terminal$/);
    expect(renderOutcome({ ...base, answer: { type: "answers", answers: { Q: "A" } } }).content).toMatch(/\nAnswered: Q → A$/);
    expect(renderOutcome({ ...base, status: "released", answer: undefined }).content).toMatch(/\nBack at the terminal\.$/);
    expect(renderOutcome({ ...base, status: "expired", answer: undefined }).content).toMatch(/\nExpired\. Answer in the terminal\.$/);
    expect(renderOutcome(base).components).toBeUndefined();
  });

  it("outcome wording follows the kind and state", () => {
    const stop = rec({ kind: "stop", mode: "done", text: "the reply", status: "expired" });
    expect(renderOutcome(stop).content).toMatch(/\nReply window closed\.$/);
    expect(renderOutcome({ ...stop, status: "released" }).content).toMatch(/\nBack at the terminal\.$/);
    expect(renderOutcome({ ...stop, mode: "turn" }).content).toMatch(/\nExpired\. Answer in the terminal\.$/);
  });

  it("outcome escapes its text and keeps the whole message within 2000 characters", () => {
    const answered = rec({ kind: "stop", mode: "turn", text: "z".repeat(1900), status: "answered", answer: { type: "text", text: "**hi** @everyone ".repeat(100) } });
    const { content } = renderOutcome(answered);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("Answered: \\*\\*hi\\*\\* \\@everyone");
    expect(content).toContain("z".repeat(1000));
  });
});

describe("discord rest", () => {
  it("mentions are never parsed", async () => {
    const { calls } = stubDiscord();
    await sendMessage("test-token", "c1", { content: "@everyone hi", components: [] });
    await editMessage("test-token", "c1", "m1", { content: "<@123> edited" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /channels/c1/messages",
      "PATCH /channels/c1/messages/m1",
    ]);
    for (const c of calls) {
      expect(c.body.allowed_mentions).toEqual({ parse: [] });
      expect(c.headers.get("Authorization")).toBe("Bot test-token");
    }
    expect(calls[0].body.content).toBe("@everyone hi");
    expect(calls[1].body.components).toEqual([]);
    const [m] = renderRequest(rec({ kind: "stop", mode: "turn", text: "@everyone look" }));
    expect(m.content).toContain("@everyone look");
  });

  it("errors never carry the token", async () => {
    stubDiscord(() => new Response("nope Bot test-token", { status: 403 }));
    const err = await sendMessage("test-token", "123", { content: "x" }).catch((e) => e as Error);
    if (typeof err === "string") throw new Error("expected an Error");
    expect(err.message).toBe("Discord POST /channels/:id/messages failed with 403");
  });

  it("errors carry Discord's JSON error code and nothing else from the body", async () => {
    stubDiscord(() => Response.json({ code: 50007, message: "Cannot send messages to this user Bot test-token" }, { status: 403 }));
    const err = (await sendMessage("test-token", "123", { content: "secret text" }).catch((e) => e)) as Error;
    expect(err.message).toBe("Discord POST /channels/:id/messages failed with 403 (code 50007)");
  });

  it("a 429 waits retry_after and retries once", async () => {
    let n = 0;
    const { calls } = stubDiscord(() => (++n === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : undefined));
    expect(await sendMessage("test-token", "c1", { content: "hi" })).toMatch(/^m/);
    expect(calls).toHaveLength(2);
    const again = stubDiscord(() => Response.json({ retry_after: 0.01 }, { status: 429 }));
    const err = (await sendMessage("test-token", "123", { content: "hi" }).catch((e) => e)) as Error;
    expect(err.message).toBe("Discord POST /channels/:id/messages failed with 429");
    expect(again.calls).toHaveLength(2);
  });
});

describe("DM delivery", () => {
  it("sends the permission DM once and records channel:message ids", async () => {
    const { calls } = stubDiscord();
    const res = await post(PERM);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const sends = calls.filter((c) => c.path === "/channels/dm-channel/messages");
    expect(sends).toHaveLength(1);
    expect(sends[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(sends[0].body.components[0].components[0].custom_id).toBe(`b:${id}:allow`);
    const record = await bridge().get(id);
    expect(record?.messageIds).toHaveLength(1);
    expect(record?.messageIds[0]).toMatch(/^dm-channel:m\d+$/);
  });

  it("caches the DM channel under dm:<userId>", async () => {
    await runInDurableObject(bridge(), (_i, state) => state.storage.delete("dm:test-user-id"));
    const { calls } = stubDiscord();
    await post(PERM);
    await post(PERM);
    expect(calls.filter((c) => c.path === "/users/@me/channels")).toHaveLength(1);
    const cached = await runInDurableObject(bridge(), (_i, state) => state.storage.get("dm:test-user-id"));
    expect(cached).toBe("dm-channel");
  });

  it("a failed send releases the request and answers 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDiscord((c) => (c.path.endsWith("/messages") ? new Response("{}", { status: 500 }) : undefined));
    const res = await post(PERM);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("released");
    expect((await bridge().get(body.id))?.status).toBe("released");
  });

  it("a fetch that throws releases the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDiscord(() => {
      throw new Error("network down");
    });
    const res = await post(PERM);
    expect(res.status).toBe(502);
  });

  it("stop requests with status none send no DM", async () => {
    const { calls } = stubDiscord();
    const res = await post({ kind: "stop", machine: "mac", project: "proj", session: "s-nodm-1", text: "done" });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("long stop requests are DM'd", async () => {
    const { calls } = stubDiscord();
    const res = await post({ kind: "stop", machine: "mac", project: "proj", session: "s1", text: "hi", elapsedSeconds: 3600 });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(calls.filter((c) => c.path === "/channels/dm-channel/messages")).toHaveLength(1);
    expect((await bridge().get(id))?.messageIds).toHaveLength(1);
  });

  it("stop requests in mode none send no DM", async () => {
    const { calls } = stubDiscord();
    const res = await post({ kind: "stop", machine: "mac", project: "proj", session: "s-nodm-2", text: "x", elapsedSeconds: 1 });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("a split message that fails partway is cleaned up and releases the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let sends = 0;
    const { calls } = stubDiscord((c) =>
      c.method === "POST" && c.path.endsWith("/messages") && ++sends === 2 ? new Response("{}", { status: 500 }) : undefined,
    );
    const res = await post({
      kind: "stop", machine: "mac", project: "proj", session: "s1", elapsedSeconds: 3600, text: "x".repeat(4500),
    });
    expect(res.status).toBe(502);
    const { id, status } = (await res.json()) as { id: string; status: string };
    expect(status).toBe("released");
    const record = await bridge().get(id);
    expect(record?.status).toBe("released");
    expect(record?.messageIds).toEqual([]);
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toMatch(/^\/channels\/dm-channel\/messages\/m\d+$/);
  });

  it("a release landing while the DM send is in flight survives", async () => {
    let released: Promise<unknown> | undefined;
    stubDiscord(async (c) => {
      if (c.path.endsWith("/messages") && !released) {
        const id = JSON.stringify(c.body).match(/b:([a-z]+):allow/)![1];
        released = bridge().release(id, CALLER);
        await released;
      }
      return undefined as Response | undefined;
    });
    const res = await post(PERM);
    expect(released).toBeDefined();
    expect(res.status).toBe(201);
    const { id, status } = (await res.json()) as { id: string; status: string };
    expect(status).toBe("released");
    const record = await bridge().get(id);
    expect(record?.status).toBe("released");
    expect(record?.messageIds).toHaveLength(1);
  });
});
