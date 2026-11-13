export interface Env {
  BRIDGE: DurableObjectNamespace;
  DISCORD_BOT_TOKEN: string;
  // Optional overrides: when set, they win over what the Worker looks up from Discord.
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APP_ID?: string;
  ALLOWED_USER_IDS?: string;
  STOP_MINUTES?: string;
}

// Types `env` from cloudflare:test / cloudflare:workers with our bindings.
declare global {
  namespace Cloudflare {
    interface Env extends Pick<
      import("./env").Env,
      "BRIDGE" | "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY" | "DISCORD_APP_ID" | "ALLOWED_USER_IDS" | "STOP_MINUTES"
    > {}
  }
}
