// Replies shared by the request and join interaction handlers.
import { withOutcome } from "./render";

export const EPHEMERAL = 64;
export const MSG_STRANGER = "Only the bridge's owner can answer this.";
export const MSG_HANDLED = "Already handled.";
export const MSG_GONE = "No longer available.";

export function refuse(content: string): Response {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

// A press on a message that can no longer act: the message keeps its text, gains an outcome line
// and loses its buttons (interaction response type 7).
export function staleUpdate(original: string, outcome: string): Response {
  const content = withOutcome(original, outcome);
  return Response.json({ type: 7, data: { content, components: [], allowed_mentions: { parse: [] } } });
}
