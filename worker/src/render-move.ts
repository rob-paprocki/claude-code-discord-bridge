// The DM that asks the owner to move Discord's button presses to this Worker, and its end states.
import type { OutMessage } from "./discord/rest";
import { SUPPRESS_EMBEDS } from "./render-join";
import type { MoveRequest } from "./setup-row";

export function renderMoveRequest(move: MoveRequest, link: string): OutMessage {
  return {
    flags: SUPPRESS_EMBEDS,
    content: `Move the bridge's Discord buttons to \`${move.origin}\`?\nThe link works for 10 minutes. Ignore it to keep the buttons where they are.`,
    // A link button: it opens this Worker in the browser, so it works wherever presses go now.
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Review the move", url: link }] }],
  };
}

// The DM once the request has ended: no link, and the outcome.
export function renderMoveState(move: MoveRequest): OutMessage {
  let content: string;
  if (move.status === "moved") content = `**Moved** · \`${move.origin}\``;
  else if (move.status === "expired") content = "**Not moved** (expired)";
  else if (move.refused?.length) content = `**Not moved**: Discord refused the address. ${move.refused.join(" ")}`;
  else content = "**Not moved**";
  return { flags: SUPPRESS_EMBEDS, content };
}
