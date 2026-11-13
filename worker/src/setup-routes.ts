// The status page and its buttons: GET /, POST /setup/test-dm, POST /setup/move, and the move
// link's page (GET and POST /setup/move/<id>).
import type { Bridge } from "./bridge";
import { runMessageEdits } from "./dm";
import type { Env } from "./env";
import { sha256Hex } from "./keys";
import { COPY, htmlResponse, refusedText, renderMoveConfirm, renderMoveGone, renderStatusPage, statusView } from "./status-page";

// How long the status page waits for a fresh check with Discord before it shows what it has.
const STATUS_WAIT_MS = 5000;
const NO_DM_CODES = [50007, 50278];

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function statusPage(env: Env, bridge: DurableObjectStub<Bridge>, origin: string, notice: string | null): Promise<Response> {
  return htmlResponse(renderStatusPage(statusView(await bridge.setupRow(), env, origin, notice)));
}

function dmRefusal(code: number): string {
  return NO_DM_CODES.includes(code) ? COPY.noDm : COPY.dmFailed;
}

// The response for a setup route, or null when the request is not one.
export async function handleSetupRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  bridge: DurableObjectStub<Bridge>,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname, origin } = url;
  if (pathname === "/" && req.method === "GET") {
    const checked = await withTimeout(bridge.ensureSetup(origin, { force: true }), STATUS_WAIT_MS);
    return statusPage(env, bridge, origin, checked.done ? null : COPY.checking);
  }
  if (pathname === "/setup/test-dm" && req.method === "POST") {
    const r = await bridge.testDm();
    const notice = r === "sent" ? COPY.testSent : r === "limited" ? COPY.limited : r === "no-owner" ? COPY.noOwner : dmRefusal(r.refused);
    return statusPage(env, bridge, origin, notice);
  }
  if (pathname === "/setup/move" && req.method === "POST") {
    const r = await bridge.requestMove(origin);
    const notice =
      r === "sent"
        ? COPY.moveSent
        : r === "limited"
          ? COPY.limited
          : r === "not-needed"
            ? COPY.notNeeded
            : r === "no-owner"
              ? COPY.noOwner
              : dmRefusal(r.refused);
    return statusPage(env, bridge, origin, notice);
  }
  const link = pathname.match(/^\/setup\/move\/([0-9a-f]{16})$/);
  if (!link) return null;
  const id = link[1];
  if (req.method === "GET") {
    const k = url.searchParams.get("k") ?? "";
    const move = k ? await bridge.moveLink(id, await sha256Hex(k)) : null;
    return move ? htmlResponse(renderMoveConfirm(move.origin, id, k)) : htmlResponse(renderMoveGone(), 404);
  }
  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const k = form?.get("k");
    if (typeof k !== "string" || k === "") return htmlResponse(renderMoveGone(), 404);
    const r = await bridge.answerMove(id, await sha256Hex(k), form?.get("choice") === "move");
    runMessageEdits(env, ctx, r.edits);
    if (r.result === "gone") return htmlResponse(renderMoveGone(), 404);
    const notice =
      r.result === "moved" ? COPY.moved : r.result === "kept" ? COPY.kept : `Discord refused the address: ${refusedText(r.result.refused)}`;
    return statusPage(env, bridge, origin, notice);
  }
  return null;
}
