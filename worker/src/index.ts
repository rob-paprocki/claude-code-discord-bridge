import { handleApi } from "./api";
import type { Bridge } from "./bridge";
import { handleInteraction, type DiscordInteraction } from "./interactions";
import { handleCommand } from "./join-interactions";
import { verifyDiscordRequest } from "./discord/verify";
import type { Env } from "./env";
import { resolveConfig } from "./setup-row";
import { handleSetupRoute } from "./setup-routes";

export { Bridge } from "./bridge";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/health") {
      return new Response("ok");
    }
    const bridge = env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
    // Finish the setup in the background; no response waits for it.
    ctx.waitUntil(bridge.autoSetup(url.origin).catch(() => {}));
    if (pathname === "/discord/interactions" && req.method === "POST") {
      const config = resolveConfig(env, await bridge.setupRow());
      // No key yet, neither set nor looked up: Discord cannot have a URL pointing here.
      if (!config.publicKey) return new Response("setup not finished", { status: 503 });
      const verified = await verifyDiscordRequest(req, config.publicKey);
      if (!verified.ok) {
        return new Response("invalid request signature", { status: 401 });
      }
      let interaction: DiscordInteraction;
      try {
        interaction = JSON.parse(verified.body);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }
      if (interaction.type === 2) {
        return handleCommand(interaction, env, config);
      }
      if (interaction.type === 3 || interaction.type === 5) {
        return handleInteraction(interaction, env, ctx, config);
      }
      return new Response("unsupported interaction", { status: 400 });
    }
    if (pathname.startsWith("/api/")) {
      return handleApi(req, env, ctx);
    }
    const setup = await handleSetupRoute(req, env, ctx, bridge);
    if (setup) return setup;
    return new Response("not found", { status: 404 });
  },
};
