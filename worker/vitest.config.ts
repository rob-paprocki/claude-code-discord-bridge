import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./test/setup-seed.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Placeholder value only. The rest of the setup comes from the row test/setup-seed.ts seeds.
        bindings: { DISCORD_BOT_TOKEN: "test-token" },
      },
    }),
  ],
});
