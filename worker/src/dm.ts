import { editMessage } from "./discord/rest";
import type { Env } from "./env";
import { renderOutcome } from "./render";
import type { OutMessage } from "./discord/rest";
import type { RequestRecord } from "./types";

// The last message in each channel ("channelId:messageId" entries): the one that carries the buttons.
export function lastPerChannel(messageIds: string[]): Array<[string, string]> {
  const last = new Map<string, string>();
  for (const entry of messageIds) {
    const [channelId, messageId] = entry.split(":");
    if (channelId && messageId) last.set(channelId, messageId);
  }
  return [...last];
}

// A DM edit the Bridge has decided on. The state change is already saved; the edit itself runs
// after the response (see runEdits), so a slow Discord cannot hold up an answer or a hook's POST.
export interface DmEdit {
  record: RequestRecord;
  outcome?: string;
}

// Replaces the buttons-carrying (last) message in each channel with the same text plus an outcome
// line. Failures are logged without any message content.
export async function editDm(env: Env, edit: DmEdit): Promise<void> {
  for (const [channelId, messageId] of lastPerChannel(edit.record.messageIds)) {
    try {
      await editMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, renderOutcome(edit.record, edit.outcome));
    } catch (err) {
      console.error("discord edit failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
}

// Hands the edits to the Worker's ExecutionContext so they finish after the response is sent.
export function runEdits(env: Env, ctx: ExecutionContext, edits: DmEdit[] | undefined): void {
  for (const edit of edits ?? []) ctx.waitUntil(editDm(env, edit));
}

// A DM edit that is not tied to a RequestRecord (join and machine messages).
export interface MessageEdit {
  messageIds: string[];
  message: OutMessage;
}

// Replaces the last message in each channel with the given one. Failures are logged without content.
export async function editMessages(env: Env, edit: MessageEdit): Promise<void> {
  for (const [channelId, messageId] of lastPerChannel(edit.messageIds)) {
    try {
      await editMessage(env.DISCORD_BOT_TOKEN, channelId, messageId, edit.message);
    } catch (err) {
      console.error("discord edit failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
}

export function runMessageEdits(env: Env, ctx: ExecutionContext, edits: MessageEdit[] | undefined): void {
  for (const edit of edits ?? []) ctx.waitUntil(editMessages(env, edit));
}
