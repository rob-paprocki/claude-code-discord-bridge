import type { Bridge } from "./bridge";
import { lastPerChannel } from "./dm";
import { editMessage } from "./discord/rest";
import type { Env } from "./env";
import { handleJoinInteraction } from "./join-interactions";
import { orderedAnswers, outcomeLine, permissionOutcome, renderOutcome, renderRequest } from "./render";
import { MSG_GONE, MSG_HANDLED, MSG_STRANGER, refuse, staleUpdate } from "./replies";
import type { Config } from "./setup-row";
import type { Answer, RequestRecord } from "./types";
import { type DiscordInteraction, isAllowedUser } from "./users";

export { staleUpdate };

export type { DiscordInteraction };

const MODAL_KINDS = ["answer", "chat", "reply"] as const;
type ModalKind = (typeof MODAL_KINDS)[number];

const MSG_LATE = "Too late: this was already handled. What you typed:";
const CONTENT_MAX = 2000;

// The original message content stays whole where it can; the outcome is escaped and cut to fit.

// A press on a request that can no longer act: the message loses its buttons and says what happened.
export function staleRecordUpdate(i: DiscordInteraction, record: RequestRecord | undefined): Response {
  // Still pending: the press was refused for another reason, so the message must keep its buttons.
  if (record?.status === "pending") return refuse(MSG_HANDLED);
  return staleUpdate(i.message?.content ?? "", (record && outcomeLine(record)) || MSG_GONE);
}

// A modal submitted too late: the typed text is shown back privately so it is not lost.
function lateText(text: string): Response {
  if (text === "") return refuse(MSG_LATE);
  // Discord only knows ``` fences and closes the block at the next ```, so runs of two or more
  // backticks are broken with zero-width spaces (as render.ts fenced() does) inside a ``` fence.
  const head = `${MSG_LATE}\n\`\`\`\n`;
  const tail = "\n```";
  let body = text.replace(/`{2,}/g, (run) => run.split("").join("\u200b"));
  const room = CONTENT_MAX - head.length - tail.length;
  if (body.length > room) {
    let end = room - 1;
    // Never cut a surrogate pair.
    if (/[\ud800-\udbff]/.test(body[end - 1] ?? "")) end -= 1;
    body = `${body.slice(0, end)}…`;
  }
  return refuse(head + body + tail);
}

function outcomeFor(a: Answer): string {
  if ("behavior" in a) return permissionOutcome(a);
  switch (a.type) {
    case "text":
      return `Answered: ${a.text}`;
    case "chat":
      return `Chat: ${a.text}`;
    case "back":
      return "Back to terminal";
    case "answers":
      return "Answered";
  }
}

function modal(id: string, kind: ModalKind): Response {
  const title = { answer: "Answer", chat: "Chat", reply: "Reply" }[kind];
  return Response.json({
    type: 9,
    data: {
      custom_id: `m:${id}:${kind}`,
      title,
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: "t", label: title, style: 2, required: true, max_length: 4000 }],
        },
      ],
    },
  });
}

// Edits the buttons-bearing (last) message sent to every other user so no live buttons remain.
function clearOtherMessages(env: Env, ctx: ExecutionContext, record: RequestRecord, pressed: string): void {
  for (const [channelId, messageId] of lastPerChannel(record.messageIds)) {
    if (`${channelId}:${messageId}` === pressed) continue;
    ctx.waitUntil(
      editMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, renderOutcome(record)).catch((err) => {
        console.error("discord edit failed:", err instanceof Error ? err.message : "unknown error");
      }),
    );
  }
}

// Option labels for a choice press, or null when the indexes do not fit the request.
function chosenLabels(i: DiscordInteraction, record: RequestRecord, parts: string[]): { qi: number; labels: string[] } | null {
  const isSelect = parts[0] === "s";
  const qi = Number(isSelect ? parts[2] : parts[3]);
  const q = Number.isInteger(qi) ? record.questions?.[qi] : undefined;
  if (!q) return null;
  const raw = isSelect ? (i.data?.values ?? []) : [parts[4]];
  const indexes = raw.map((v) => (/^\d+$/.test(v ?? "") ? Number(v) : -1));
  if (indexes.length === 0 || indexes.some((oi) => oi < 0 || oi >= q.options.length)) return null;
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  return { qi, labels: sorted.map((oi) => q.options[oi].label) };
}

async function handleChoice(
  i: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  bridge: DurableObjectStub<Bridge>,
  pending: RequestRecord,
  parts: string[],
  userId: string,
): Promise<Response> {
  const choice = chosenLabels(i, pending, parts);
  if (!choice) return refuse(MSG_HANDLED);
  const result = await bridge.choose(pending.id, choice.qi, choice.labels, userId);
  if (result === "forbidden") return refuse(MSG_STRANGER);
  if (result === "stale") {
    return staleRecordUpdate(i, (await bridge.press(pending.id))?.record);
  }
  const record = (await bridge.get(pending.id)) ?? pending;
  const original = i.message?.content ?? "";
  if (result === "ok") {
    // Components come from the stored record so the chosen options show as ticked.
    const comps = renderRequest(record).at(-1)?.components ?? [];
    return Response.json({ type: 7, data: { content: original, components: comps, allowed_mentions: { parse: [] } } });
  }
  const channelId = i.message?.channel_id ?? i.channel_id ?? "";
  clearOtherMessages(env, ctx, record, `${channelId}:${i.message?.id ?? ""}`);
  const answers =
    record.answer && "answers" in record.answer ? orderedAnswers(record.answer.answers, record.questions).map(([, v]) => v) : [];
  return staleUpdate(original, `Answered: ${answers.join("; ")}`);
}

function modalText(i: DiscordInteraction): string {
  const v = i.data?.components?.flatMap((r) => r.components ?? []).find((c) => c.custom_id === "t")?.value;
  return typeof v === "string" ? v : "";
}

export async function handleInteraction(i: DiscordInteraction, env: Env, ctx: ExecutionContext, config: Config): Promise<Response> {
  const userId = i.member?.user?.id ?? i.user?.id ?? "";
  if (!isAllowedUser(i, config.allowed)) return refuse(MSG_STRANGER);

  const customId = i.data?.custom_id ?? "";
  if (/^(j|mc|ml):/.test(customId)) return handleJoinInteraction(i, env, ctx);

  const parts = customId.split(":");
  const [prefix, id, action] = parts;
  const isButton = i.type === 3 && prefix === "b" && !!id && !!action;
  const isSelect = i.type === 3 && prefix === "s" && !!id;
  const isModal = i.type === 5 && prefix === "m" && !!id && MODAL_KINDS.includes(action as ModalKind);
  if (!isButton && !isSelect && !isModal) return refuse(MSG_HANDLED);

  const bridge = env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
  const pressed = await bridge.press(id);
  if (!pressed || pressed.record.status !== "pending") {
    return isModal ? lateText(modalText(i)) : staleRecordUpdate(i, pressed?.record);
  }

  if (isSelect || (isButton && action === "opt")) return handleChoice(i, env, ctx, bridge, pressed.record, parts, userId);

  let answer: Answer;
  let result: "ok" | "stale" | "forbidden";
  if (isModal) {
    const text = modalText(i);
    if (typeof text !== "string" || text === "") return refuse(MSG_HANDLED);
    answer = action === "chat" ? { type: "chat", text } : { type: "text", text };
    result = await bridge.answer(id, answer, userId);
  } else if (action === "allow" || action === "deny") {
    answer = { behavior: action };
    result = await bridge.answer(id, answer, userId);
  } else if (pressed.record.kind === "permission" && (action === "auto" || (action === "always" && pressed.record.always))) {
    answer = { behavior: "allow", scope: action };
    result = await bridge.answer(id, answer, userId);
  } else if (action === "back") {
    answer = { type: "back" };
    result = await bridge.back(id, userId);
  } else if (MODAL_KINDS.includes(action as ModalKind)) {
    return modal(id, action as ModalKind);
  } else {
    return refuse(MSG_HANDLED);
  }

  if (result === "forbidden") return refuse(MSG_STRANGER);
  if (result === "stale") {
    const again = await bridge.press(id);
    return isModal ? lateText(modalText(i)) : staleRecordUpdate(i, again?.record);
  }

  const record = (await bridge.get(id)) ?? pressed.record;
  const channelId = i.message?.channel_id ?? i.channel_id ?? "";
  clearOtherMessages(env, ctx, record, `${channelId}:${i.message?.id ?? ""}`);
  return staleUpdate(i.message?.content ?? "", outcomeFor(answer));
}
