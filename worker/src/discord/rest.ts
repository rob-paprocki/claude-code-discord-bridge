import { VERSION } from "../version";

const API = "https://discord.com/api/v10";

export interface OutMessage {
  content: string;
  components?: object[];
  flags?: number;
}

const RETRY_CAP_MS = 5000;

const FIELD_MESSAGE_CAP = 200;

// A failed Discord call: the HTTP status, Discord's numeric error code (for example 50007: cannot
// send messages to this user) and the per-field validation messages under `errors`, each capped.
// The message holds only the method, the path shape, the status and the code, so logging it is safe.
export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
    readonly fieldMessages: string[],
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

// The `_errors[].message` strings anywhere under Discord's `errors` object.
function fieldMessagesOf(errors: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v !== "object" || v === null) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === "_errors" && Array.isArray(child)) {
        for (const e of child) {
          const m = (e as { message?: unknown } | null)?.message;
          if (typeof m === "string") out.push(m.slice(0, FIELD_MESSAGE_CAP));
        }
      } else {
        walk(child);
      }
    }
  };
  walk(errors);
  return out;
}

async function errorDetails(res: Response): Promise<{ code?: number; fieldMessages: string[] }> {
  try {
    const body = (await res.json()) as { code?: unknown; errors?: unknown };
    return {
      code: typeof body.code === "number" ? body.code : undefined,
      fieldMessages: fieldMessagesOf(body.errors),
    };
  } catch {
    return { fieldMessages: [] };
  }
}

async function retryDelayMs(res: Response): Promise<number> {
  let seconds = Number(res.headers.get("Retry-After"));
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number") seconds = body.retry_after;
  } catch {
    // Keep the header value.
  }
  return Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, RETRY_CAP_MS);
}

// Never put the token, request bodies or response text in the error text. The status and
// Discord's numeric error code are the only parts of a response that get logged. A 429 waits
// retry_after (at most 5 s) and retries once.
async function call(token: string, method: string, path: string, body?: object): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": `DiscordBot (claude-code-discord-bridge, ${VERSION})`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    if (res.status === 429 && attempt === 0) {
      const delay = await retryDelayMs(res);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const { code, fieldMessages } = await errorDetails(res);
    const where = path.replace(/\/\d+/g, "/:id");
    throw new DiscordError(
      `Discord ${method} ${where} failed with ${res.status}${code === undefined ? "" : ` (code ${code})`}`,
      res.status,
      code,
      fieldMessages,
    );
  }
}

function messageBody(msg: OutMessage, clearComponents: boolean): object {
  const body: Record<string, unknown> = { content: msg.content, allowed_mentions: { parse: [] } };
  if (msg.flags !== undefined) body.flags = msg.flags;
  if (msg.components) body.components = msg.components;
  else if (clearComponents) body.components = [];
  return body;
}

export async function openDm(token: string, userId: string): Promise<string> {
  const res = (await call(token, "POST", "/users/@me/channels", { recipient_id: userId })) as { id: string };
  return res.id;
}

export async function sendMessage(token: string, channelId: string, msg: OutMessage): Promise<string> {
  const res = (await call(token, "POST", `/channels/${channelId}/messages`, messageBody(msg, false))) as { id: string };
  return res.id;
}

// An edit without components removes the buttons.
export async function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  msg: OutMessage,
): Promise<void> {
  await call(token, "PATCH", `/channels/${channelId}/messages/${messageId}`, messageBody(msg, true));
}

export async function deleteMessage(token: string, channelId: string, messageId: string): Promise<void> {
  await call(token, "DELETE", `/channels/${channelId}/messages/${messageId}`);
}

// The global /machines command (usable in DMs only).
export const MACHINES_COMMAND = {
  name: "machines",
  description: "List joined machines and remove one",
  type: 1,
  contexts: [1],
};

// Registers /machines. Safe to repeat: Discord overwrites a command of the same name.
export async function registerCommand(token: string, appId: string): Promise<void> {
  await call(token, "POST", `/applications/${appId}/commands`, MACHINES_COMMAND);
}

// The fields of Discord's Application object the setup reads.
export interface DiscordApplication {
  id: string;
  verify_key: string;
  owner?: { id: string };
  team?: { owner_user_id?: string } | null;
  interactions_endpoint_url?: string | null;
  bot?: { username?: string };
}

export async function getApplication(token: string): Promise<DiscordApplication> {
  return (await call(token, "GET", "/applications/@me")) as DiscordApplication;
}

// Discord checks the new URL by sending it a signed PING before it saves it.
export async function setInteractionsUrl(token: string, url: string): Promise<void> {
  await call(token, "PATCH", "/applications/@me", { interactions_endpoint_url: url });
}

export async function getBotName(token: string): Promise<string | null> {
  const me = (await call(token, "GET", "/users/@me")) as { username?: unknown };
  return typeof me.username === "string" ? me.username : null;
}
