import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordError,
  getApplication,
  MACHINES_COMMAND,
  registerCommand,
  setInteractionsUrl,
} from "../src/discord/rest";
import { overrideOf } from "../src/setup-row";
import { bridge } from "./helpers/join";
import { stubDiscord } from "./helpers/discordRest";
import { clearSetup } from "./setup-seed";

afterEach(() => vi.restoreAllMocks());

describe("Discord application calls", () => {
  it("getApplication returns the parsed body", async () => {
    const app = { id: "a1", verify_key: "ab", owner: { id: "u1" } };
    const { calls } = stubDiscord((c) => (c.method === "GET" && c.path === "/applications/@me" ? Response.json(app) : undefined));
    expect(await getApplication("test-token")).toEqual(app);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("Authorization")).toBe("Bot test-token");
  });

  it("setInteractionsUrl sends PATCH with only the url", async () => {
    const { calls } = stubDiscord(() => Response.json({ id: "a1" }));
    await setInteractionsUrl("test-token", "https://x.example/discord/interactions");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toBe("/applications/@me");
    expect(calls[0].body).toEqual({ interactions_endpoint_url: "https://x.example/discord/interactions" });
  });

  it("DiscordError carries status, code and field messages", async () => {
    const body = {
      code: 50035,
      message: "Invalid Form Body",
      errors: {
        interactions_endpoint_url: {
          _errors: [{ code: "X", message: "The specified interactions endpoint url could not be verified." }],
        },
      },
    };
    stubDiscord(() => Response.json(body, { status: 400 }));
    const err = await setInteractionsUrl("test-token", "https://x.example/discord/interactions").catch((e) => e);
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(50035);
    expect(err.fieldMessages).toEqual(["The specified interactions endpoint url could not be verified."]);
    expect(err.message).not.toContain("Invalid Form Body");
    expect(err.message).not.toContain("test-token");
  });

  it("fieldMessages are capped at 200 characters", async () => {
    const long = "y".repeat(500);
    stubDiscord(() => Response.json({ code: 50035, errors: { a: { b: { _errors: [{ message: long }] } } } }, { status: 400 }));
    const err = (await getApplication("test-token").catch((e) => e)) as DiscordError;
    expect(err.fieldMessages).toHaveLength(1);
    expect(err.fieldMessages[0].length).toBe(200);
  });

  it("a non-JSON error body gives a DiscordError with no code or messages", async () => {
    stubDiscord(() => new Response("bad gateway", { status: 502 }));
    const err = (await getApplication("test-token").catch((e) => e)) as DiscordError;
    expect(err).toBeInstanceOf(DiscordError);
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.fieldMessages).toEqual([]);
  });

  it("registerCommand sends MACHINES_COMMAND", async () => {
    const { calls } = stubDiscord(() => Response.json({ id: "c1" }));
    await registerCommand("test-token", "a1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/applications/a1/commands");
    expect(calls[0].body).toEqual(MACHINES_COMMAND);
    expect(MACHINES_COMMAND).toEqual({ name: "machines", description: "List joined machines and remove one", type: 1, contexts: [1] });
  });
});

describe("overrideOf", () => {
  it("treats missing, empty and blank values as unset", () => {
    expect(overrideOf(undefined)).toBeNull();
    expect(overrideOf("")).toBeNull();
    expect(overrideOf("  ")).toBeNull();
    expect(overrideOf(" x ")).toBe("x");
  });
});

describe("setup row", () => {
  it("setupRow round-trips and the seed is present", async () => {
    const row = await bridge().setupRow();
    expect(row?.ownerId).toBe("test-user-id");
    expect(row?.appId).toBe("test-app-id");
    await clearSetup();
    expect(await bridge().setupRow()).toBeNull();
  });
});
