import type { OutMessage } from "./discord/rest";
import { BUTTON_DANGER, BUTTON_SECONDARY, BUTTON_SUCCESS, button } from "./render";
import type { JoinRecord, MachineRecord } from "./types";

export const SUPPRESS_EMBEDS = 1 << 2;
const LABEL_MAX = 80;

// A machine name for message content: inside an inline code span, so links stay inert and need no
// escaping; a backtick in the name becomes an apostrophe.
export function nameSpan(name: string): string {
  return `\`${name.replace(/\s+/g, " ").trim().replace(/`/g, "'")}\``;
}

// The Joined message's single button row.
export function removeRow(machineId: string): object[] {
  return [{ type: 1, components: [button(BUTTON_DANGER, "Remove this machine", `mc:${machineId}:remove`)] }];
}

// Asks for confirmation before a machine is removed.
export function confirmRemoveRow(machineId: string, name: string): object[] {
  return [
    {
      type: 1,
      components: [
        button(BUTTON_DANGER, clipText(`Confirm remove ${name}`, LABEL_MAX), `mc:${machineId}:confirm`),
        button(BUTTON_SECONDARY, "Cancel", `mc:${machineId}:cancel`),
      ],
    },
  ];
}

export function renderJoinRequest(j: JoinRecord): OutMessage {
  return {
    flags: SUPPRESS_EMBEDS,
    content: `**New machine wants to join** · ${nameSpan(j.machine)} · code \`${j.code}\``,
    components: [
      {
        type: 1,
        components: [
          button(BUTTON_SUCCESS, "Approve", `j:${j.id}:approve`),
          button(BUTTON_DANGER, "Deny", `j:${j.id}:deny`),
        ],
      },
    ],
  };
}

// The join DM after it has ended. Only a joined machine keeps a button (Remove).
export function renderJoinState(j: JoinRecord, m?: MachineRecord): OutMessage {
  return { ...joinStateBody(j, m), flags: SUPPRESS_EMBEDS };
}

function joinStateBody(j: JoinRecord, m?: MachineRecord): OutMessage {
  const who = `${nameSpan(j.machine)} · code \`${j.code}\``;
  if (m?.status === "removed") return { content: `**Removed** · ${who}` };
  switch (j.status) {
    case "approved":
    case "delivered": {
      const machineId = m?.id ?? j.machineId;
      return {
        content: `**Joined** · ${who}`,
        ...(machineId ? { components: removeRow(machineId) } : {}),
      };
    }
    case "denied":
      return { content: `**Denied** · ${who}` };
    case "expired":
      return { content: `**Expired. Run the installer again to retry.** · ${who}` };
    case "cancelled":
      return { content: `**Cancelled** · ${who}` };
    case "pending":
      return renderJoinRequest(j);
  }
}

const LIST_ROWS = 5;
const LIST_MAX = 2000;

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const minute = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// A Remove label whose name gives way to the date and suffix, so it stays within LABEL_MAX.
function removeLabel(name: string, date: string, suffix: string): string {
  const tail = ` (${date})${suffix}`;
  return `Remove ${clipText(name, LABEL_MAX - "Remove ".length - tail.length)}${tail}`;
}

function confirmLabel(name: string, suffix: string): string {
  return `Confirm remove ${clipText(name, LABEL_MAX - "Confirm remove ".length - suffix.length)}${suffix}`;
}

// The /machines answer: at most five machines (the caller passes them least recently seen first),
// one button each. With `confirming`, that machine's row asks Confirm remove / Cancel instead.
// Machines whose labels would match get their id's first six characters as a tell-apart suffix.
export function renderMachineList(machines: MachineRecord[], confirming?: string): { content: string; components: object[] } {
  if (machines.length === 0) return { content: "No machines are joined.", components: [] };
  const shown = machines.slice(0, LIST_ROWS);
  const plain = shown.map((m) => removeLabel(m.name, day(m.joined), ""));
  const suffix = shown.map((m, i) => (plain.filter((l) => l === plain[i]).length > 1 ? ` · ${m.id.slice(0, 6)}` : ""));
  const lines = shown.map(
    (m, i) =>
      `${nameSpan(m.name)} · joined ${day(m.joined)} · last seen ${m.lastSeen === null ? "never" : minute(m.lastSeen)}${suffix[i]}`,
  );
  if (machines.length > LIST_ROWS) lines.push(`+${machines.length - LIST_ROWS} more not shown; remove one to see the rest`);
  const content = clipText(lines.join("\n"), LIST_MAX);
  const askAt = shown.findIndex((m) => m.id === confirming);
  if (askAt >= 0) {
    const ask = shown[askAt];
    return {
      content,
      components: [
        {
          type: 1,
          components: [
            button(BUTTON_DANGER, confirmLabel(ask.name, suffix[askAt]), `ml:${ask.id}:confirm`),
            button(BUTTON_SECONDARY, "Cancel", `ml:${ask.id}:cancel`),
          ],
        },
      ],
    };
  }
  return {
    content,
    components: shown.map((m, i) => ({
      type: 1,
      components: [button(BUTTON_DANGER, removeLabel(m.name, day(m.joined), suffix[i]), `ml:${m.id}:remove`)],
    })),
  };
}
