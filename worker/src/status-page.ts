// The status page at the Worker's address: what the setup found, what to do next, a test DM and,
// when Discord sends button presses elsewhere, a way to move them here. Plain HTML, no script.
// It never shows an application ID, a key, a user ID or the owner's name: the bot's name and the
// other address's host are the only names on it.
import type { Env } from "./env";
import { interactionsUrlFor } from "./setup";
import { overrideOf, resolveConfig, type SetupError, type SetupRow } from "./setup-row";

// Copy shared by the page and its notices. Values here are trusted HTML; anything from outside
// (the bot's name, a host, Discord's messages) is escaped where it is inserted.
export const COPY = {
  token:
    "The bot token isn't valid. Copy it again from the Discord Developer Portal → Bot → Reset Token, and update <code>DISCORD_BOT_TOKEN</code>.",
  unreachable: "Discord didn't answer; try again in a minute.",
  noOwner: "Owner not found: set <code>ALLOWED_USER_IDS</code> to your Discord user ID.",
  noDm: "The bot can't DM you yet. Share a server with it (any server, even a private one of your own) and allow DMs from server members.",
  keyMismatch: "<code>DISCORD_PUBLIC_KEY</code> doesn't match the key Discord reports; button presses will fail.",
  appMismatch:
    "<code>DISCORD_APP_ID</code> doesn't match the application Discord reports; <code>/machines</code> can't be registered.",
  elsewhere:
    "Discord sends button presses to another address. If this is the bridge you use, select <strong>Move the buttons here</strong>.",
  accessHint:
    "If this address is behind Cloudflare Access (some accounts protect every <code>workers.dev</code> address), Discord can't reach it: add a custom domain to the Worker and open this page there.",
  allGood: "Run the installer on each machine.",
  checking: "Still checking with Discord; reload in a minute.",
  limited: "Wait a minute before trying again.",
  testSent: "Test DM sent. Check your Discord DMs.",
  dmFailed: "Discord refused the DM; try again in a minute.",
  moveSent: "Check your Discord DMs: the link there moves the buttons here.",
  notNeeded: "The buttons already point here.",
  moved: "Moved: Discord now sends button presses here.",
  kept: "Not moved.",
  gone: "This link has expired or was already used.",
};

const OVERRIDES = ["ALLOWED_USER_IDS", "DISCORD_APP_ID", "DISCORD_PUBLIC_KEY"] as const;

const STEP_NAMES: Record<SetupError["step"], string> = {
  lookup: "looking up the application",
  url: "setting the Interactions Endpoint URL",
  commands: "registering <code>/machines</code>",
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Discord's own reason for refusing an address, escaped.
export function refusedText(messages: string[]): string {
  return messages.map(esc).join(" ");
}

export interface StatusView {
  botName: string | null;
  tokenOk: boolean;
  ownerOk: boolean;
  url: "here" | "elsewhere" | "empty";
  otherHost: string | null;
  commandsOk: boolean;
  warnings: string[];
  problem: string | null;
  notice: string | null;
  canMove: boolean;
  // The names of the optional values set in the environment (never their values).
  setByYou: string[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "another address";
  }
}

function problemOf(err: SetupError): string {
  if (err.kind === "token") return COPY.token;
  if (err.kind === "unreachable") return COPY.unreachable;
  if (err.kind === "rejected") {
    return `Discord refused this address (${refusedText(err.messages)}): the Worker could not answer Discord's check: open this page again in a minute. ${COPY.accessHint}`;
  }
  return `Discord refused a setup step (${STEP_NAMES[err.step]}); open this page again in a minute.`;
}

export function statusView(
  row: SetupRow | null,
  env: Pick<Env, "DISCORD_APP_ID" | "DISCORD_PUBLIC_KEY" | "ALLOWED_USER_IDS">,
  origin: string,
  notice: string | null,
): StatusView {
  const err = row?.error ?? null;
  const stored = row?.interactionsUrl ?? null;
  const url = !stored ? "empty" : stored === interactionsUrlFor(origin) ? "here" : "elsewhere";
  const ownerOk = resolveConfig(env, row).allowed.length > 0;
  const commandsOk = !!row?.commandsHash && err?.step !== "commands";
  const warnings: string[] = [];
  const key = overrideOf(env.DISCORD_PUBLIC_KEY);
  if (key && row?.verifyKey && key.toLowerCase() !== row.verifyKey.toLowerCase()) warnings.push(COPY.keyMismatch);
  const appId = overrideOf(env.DISCORD_APP_ID);
  if (appId && row?.appId && appId !== row.appId) warnings.push(COPY.appMismatch);
  let problem: string | null = null;
  if (!row) problem = COPY.checking;
  else if (err) problem = problemOf(err);
  else if (!ownerOk) problem = COPY.noOwner;
  else if (url === "elsewhere") problem = COPY.elsewhere;
  else if (url === "empty" || !commandsOk) problem = COPY.checking;
  return {
    botName: row?.botName ?? null,
    tokenOk: !!row?.appId && err?.kind !== "token",
    ownerOk,
    url,
    otherHost: url === "elsewhere" && stored ? hostOf(stored) : null,
    commandsOk,
    warnings,
    problem,
    notice,
    canMove: url === "elsewhere",
    setByYou: OVERRIDES.filter((name) => overrideOf(env[name]) !== null),
  };
}

const STYLE = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5}
body{margin:0;padding:2rem 1rem}main{max-width:40rem;margin:0 auto}
ul{list-style:none;padding:0}li{margin:.4rem 0}
.notice{padding:.75rem 1rem;border:1px solid currentColor;border-radius:.5rem}
.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;cursor:pointer}
code{font-size:.95em}`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

const mark = (ok: boolean) => (ok ? "✅" : "❌");

export function renderStatusPage(v: StatusView): string {
  const urlLine =
    v.url === "here"
      ? "✅ Interactions URL points here"
      : v.url === "elsewhere"
        ? `⚠️ Interactions URL points to another address (<code>${esc(v.otherHost ?? "")}</code>)`
        : "❌ Interactions URL not set yet";
  const items = [
    `${mark(v.tokenOk)} Bot token${v.tokenOk && v.botName ? `: <strong>${esc(v.botName)}</strong>` : ""}`,
    `${mark(v.ownerOk)} ${v.ownerOk ? "Owner found" : "Owner not found"}`,
    urlLine,
    `${mark(v.commandsOk)} <code>/machines</code> ${v.commandsOk ? "registered" : "not registered yet"}`,
    ...v.warnings.map((w) => `⚠️ ${w}`),
  ];
  const setByYou = v.setByYou.length
    ? `<p>Set by you: ${v.setByYou.map((n) => `<code>${n}</code>`).join(", ")}. Everything else is looked up from Discord.</p>\n`
    : "";
  const move = v.canMove
    ? `<form method="post" action="/setup/move"><button type="submit">Move the buttons here</button></form>`
    : "";
  return page(
    "Claude Code Discord bridge",
    `<h1>Claude Code Discord bridge</h1>
${v.notice ? `<p class="notice">${v.notice}</p>\n` : ""}<ul>
${items.map((i) => `<li>${i}</li>`).join("\n")}
</ul>
${setByYou}<h2>What to do next</h2>
<p>${v.problem ?? COPY.allGood}</p>
<div class="actions">
<form method="post" action="/setup/test-dm"><button type="submit">Send me a test DM</button></form>
${move}
</div>`,
  );
}

// The page a move link opens: it asks once more, so a link preview that fetches it moves nothing.
export function renderMoveConfirm(origin: string, id: string, k: string): string {
  return page(
    "Move the bridge's buttons?",
    `<h1>Move the buttons here?</h1>
<p>Discord will send the bridge's button presses to <code>${esc(origin)}</code> instead of where they go now.</p>
<form method="post" action="/setup/move/${esc(id)}">
<input type="hidden" name="k" value="${esc(k)}">
<div class="actions">
<button type="submit" name="choice" value="move">Move the buttons here</button>
<button type="submit" name="choice" value="keep">Keep them where they are</button>
</div>
</form>`,
  );
}

export function renderMoveGone(): string {
  return page("Link no longer valid", `<h1>Link no longer valid</h1>\n<p>${COPY.gone}</p>\n<p><a href="/">The status page</a></p>`);
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
