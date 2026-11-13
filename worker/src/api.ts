import { authenticate } from "./auth";
import type { Bridge } from "./bridge";
import { runEdits, runMessageEdits } from "./dm";
import type { Env } from "./env";
import { sha256Hex, cleanMachineName } from "./keys";
import type { Kind, NewRequest, Question } from "./types";

const MAX_BODY = 16 * 1024;
const OPTIONAL_STRINGS = ["title", "text", "tool", "preview", "event", "always"] as const;
const MODES: readonly string[] = ["turn", "done", "none"];
const KINDS: readonly string[] = ["permission", "question", "stop", "notify"];

function parseNewRequest(v: unknown): NewRequest | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || !KINDS.includes(o.kind)) return null;
  for (const f of ["machine", "project", "session"]) {
    if (typeof o[f] !== "string" || o[f] === "") return null;
  }
  // Only the fields NewRequest declares are copied: a hook cannot store an answer, status or flag.
  const out: NewRequest = { kind: o.kind as Kind, machine: o.machine as string, project: o.project as string, session: o.session as string };
  // A field of the wrong type is dropped, not stored.
  for (const f of OPTIONAL_STRINGS) if (typeof o[f] === "string") out[f] = o[f] as string;
  if (typeof o.elapsedSeconds === "number" && Number.isFinite(o.elapsedSeconds) && o.elapsedSeconds >= 0) out.elapsedSeconds = o.elapsedSeconds;
  if (typeof o.mode === "string" && MODES.includes(o.mode)) out.mode = o.mode as NewRequest["mode"];
  const questions = parseQuestions(o.questions);
  if (questions) out.questions = questions;
  else if (out.kind === "question") return null;
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown, type: string) => v === undefined || typeof v === type;

// The questions as typed, or null when anything in them has the wrong shape.
function parseQuestions(v: unknown): Question[] | null {
  if (!Array.isArray(v)) return null;
  const out: Question[] = [];
  for (const q of v) {
    if (!isObject(q) || typeof q.question !== "string" || !optional(q.header, "string") || !optional(q.multiSelect, "boolean") || !Array.isArray(q.options)) return null;
    const options: Question["options"] = [];
    for (const op of q.options) {
      if (!isObject(op) || typeof op.label !== "string" || !optional(op.description, "string")) return null;
      options.push(typeof op.description === "string" ? { label: op.label, description: op.description } : { label: op.label });
    }
    const item: Question = { question: q.question, options };
    if (q.header !== undefined) item.header = q.header as string;
    if (q.multiSelect !== undefined) item.multiSelect = q.multiSelect as boolean;
    out.push(item);
  }
  return out;
}

// The body as text, or null when it is over the cap (checked on Content-Length first, then while
// the stream is read).
async function readBody(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD") return "";
  const declared = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!req.body) return "";
  // Read as a stream and stop as soon as the cap is passed: never more than MAX_BODY plus one chunk.
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function bearer(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return new Response("body too large", { status: 413 });
  const bridge = env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
  const { pathname } = new URL(req.url);

  // Joining needs no key: the poll secret is the credential for one join.
  if (pathname === "/api/enroll" && req.method === "POST") {
    let name: string | null = null;
    try {
      const v = JSON.parse(body) as { machine?: unknown } | null;
      name = cleanMachineName(v && typeof v === "object" ? v.machine : undefined);
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (name === null) return new Response("invalid machine name", { status: 400 });
    const r = await bridge.enroll(name, new URL(req.url).origin);
    if (r.ok) {
      runMessageEdits(env, ctx, r.messageEdits);
      return Response.json({ id: r.id, code: r.code, secret: r.secret }, { status: 201 });
    }
    return r.error === "busy"
      ? new Response("too many joins waiting", { status: 429 })
      : new Response("could not send the join request", { status: 502 });
  }
  const enrolled = pathname.match(/^\/api\/enroll\/([0-9a-f]{32})$/);
  if (enrolled && (req.method === "GET" || req.method === "DELETE")) {
    const secret = bearer(req);
    if (!secret) return new Response("not found", { status: 404 });
    const hash = await sha256Hex(secret);
    if (req.method === "GET") {
      const r = await bridge.pollJoin(enrolled[1], hash);
      return r ? Response.json(r) : new Response("not found", { status: 404 });
    }
    const c = await bridge.cancelJoin(enrolled[1], hash);
    if (!c.ok) return new Response("not found", { status: 404 });
    runMessageEdits(env, ctx, c.edits);
    return Response.json({ status: "cancelled" });
  }

  const principal = await authenticate(req, bridge);
  if (!principal) return new Response("unauthorized", { status: 401 });

  if (pathname === "/api/machines/self") {
    if (req.method === "GET") return Response.json({ name: principal.name });
    if (req.method === "DELETE") {
      const r = await bridge.removeMachine(principal.id);
      runEdits(env, ctx, r.edits);
      runMessageEdits(env, ctx, r.messageEdits);
      return Response.json({ removed: true });
    }
  }

  if (pathname === "/api/requests" && req.method === "POST") {
    let parsed: NewRequest | null;
    try {
      const v: unknown = JSON.parse(body);
      // A machine key fixes the name: whatever the hook reported cannot fail validation.
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        (v as Record<string, unknown>).machine = principal.name;
      }
      parsed = parseNewRequest(v);
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (!parsed) return new Response("invalid request", { status: 400 });
    const { dmFailed, edits, ...created } = await bridge.create(parsed, principal);
    runEdits(env, ctx, edits);
    // A failed DM releases the request: the hook falls back to the terminal.
    return Response.json(created, { status: dmFailed ? 502 : 201 });
  }

  const ended = pathname.match(/^\/api\/sessions\/([^/]*)\/end$/);
  if (ended && req.method === "POST") {
    let session = "";
    try {
      session = decodeURIComponent(ended[1]);
    } catch {
      // Falls through to the 400 below.
    }
    if (session === "" || session.length > 200) return new Response("invalid session", { status: 400 });
    runEdits(env, ctx, (await bridge.endConversation(session)).edits);
    return Response.json({ session, conversation: false });
  }

  const m = pathname.match(/^\/api\/requests\/([a-z]+)(\/release)?$/);
  if (m) {
    const id = m[1];
    if (m[2] && req.method === "POST") {
      if (!(await bridge.poll(id, principal))) return new Response("not found", { status: 404 });
      const released = await bridge.release(id, principal);
      runEdits(env, ctx, released.edits);
      return Response.json({ status: released.status });
    }
    if (!m[2] && req.method === "GET") {
      const r = await bridge.poll(id, principal);
      if (!r) return new Response("not found", { status: 404 });
      return Response.json(r.answer === undefined ? { id, status: r.status } : { id, status: r.status, answer: r.answer });
    }
  }
  return new Response("not found", { status: 404 });
}
