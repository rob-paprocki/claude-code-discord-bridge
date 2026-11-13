import type { DiscordApplication } from "../../src/discord/rest";
import { vi } from "vitest";

export interface DiscordCall {
  method: string;
  path: string;
  headers: Headers;
  body: any;
}

// Stubs outbound calls to the Discord API; other URLs pass through.
export function stubDiscord(
  respond?: (call: DiscordCall) => Response | Promise<Response | undefined> | undefined,
): { calls: DiscordCall[] } {
  const calls: DiscordCall[] = [];
  const real = globalThis.fetch;
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (url.hostname !== "discord.com") return real(input as RequestInfo, init);
    const text = await req.text();
    const call: DiscordCall = {
      method: req.method,
      path: url.pathname.replace("/api/v10", ""),
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const custom = await respond?.(call);
    if (custom) return custom;
    if (call.path === "/users/@me/channels") return Response.json({ id: "dm-channel" });
    return Response.json({ id: `m${++n}` });
  });
  return { calls };
}

type StubAnswer = number | { status: number; body: unknown };

// A fake Discord application for the setup: GET/PATCH /applications/@me, GET /users/@me and
// POST /applications/:id/commands, and message sends ("send"). `status` makes one of them fail (a number answers that status
// with an empty JSON body). A PATCH updates the application unless `onPatch` answers it first.
// Everything else falls back to stubDiscord's defaults.
export function stubDiscordApp(
  opts: {
    app?: Partial<DiscordApplication>;
    status?: Partial<Record<"get" | "patch" | "commands" | "me" | "send", StubAnswer>>;
    onGet?: () => Promise<void>;
    onPatch?: (body: any) => Promise<Response | undefined>;
  } = {},
): { calls: DiscordCall[]; app: DiscordApplication } {
  const app: DiscordApplication = {
    id: "a1",
    verify_key: "00".repeat(32),
    owner: { id: "test-user-id" },
    interactions_endpoint_url: null,
    bot: { username: "Bridge Bot" },
    ...opts.app,
  };
  const fail = (k: "get" | "patch" | "commands" | "me" | "send"): Response | undefined => {
    const a = opts.status?.[k];
    if (a === undefined) return undefined;
    return typeof a === "number" ? Response.json({}, { status: a }) : Response.json(a.body, { status: a.status });
  };
  const { calls } = stubDiscord(async (c) => {
    if (c.path === "/applications/@me" && c.method === "GET") {
      await opts.onGet?.();
      return fail("get") ?? Response.json(app);
    }
    if (c.path === "/applications/@me" && c.method === "PATCH") {
      const failed = fail("patch") ?? (await opts.onPatch?.(c.body));
      if (failed) return failed;
      app.interactions_endpoint_url = c.body.interactions_endpoint_url;
      return Response.json(app);
    }
    if (c.path === "/users/@me" && c.method === "GET") return fail("me") ?? Response.json({ id: "bot", username: app.bot?.username ?? "Bridge Bot" });
    if (/^\/applications\/[^/]+\/commands$/.test(c.path) && c.method === "POST") return fail("commands") ?? Response.json({ id: "cmd1", ...c.body });
    if (/^\/channels\/[^/]+\/messages$/.test(c.path) && c.method === "POST") return fail("send");
    return undefined;
  });
  return { calls, app };
}
