export type Kind = "permission" | "question" | "stop" | "notify";
export type Status = "pending" | "answered" | "released" | "expired" | "sent" | "none";

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface NewRequest {
  kind: Kind;
  machine: string;
  project: string;
  session: string;
  title?: string;
  text?: string;
  tool?: string;
  preview?: string;
  questions?: Question[];
  elapsedSeconds?: number;
  event?: string;
  // Permission requests only: what Claude Code's "don't ask again" choice would cover, as text the
  // hook wrote from its permission_suggestions. Present only when Claude Code offered that choice.
  always?: string;
  // Stop requests only, set by the hook (Task 7/8): "turn" renders as Claude replied, "done" as
  // Done after, "none" (or absent) sends no DM.
  mode?: "turn" | "done" | "none";
}

export type Answer =
  // scope "always": the hook applies Claude Code's own suggestions; "auto": it switches the session
  // to auto mode. Only the hook holds the suggestions; an answer never carries rules.
  | { behavior: "allow" | "deny"; scope?: "always" | "auto" }
  | { type: "answers"; answers: Record<string, string> }
  | { type: "text"; text: string }
  | { type: "chat"; text: string }
  | { type: "back" };

export interface RequestRecord extends NewRequest {
  id: string;
  status: Status;
  created: number;
  expires: number;
  answer?: Answer;
  messageIds: string[];
  partial?: Record<string, string>;
  // Set once the expired DM has lost its buttons.
  cleared?: true;
  // Set when the request came in with a machine key: the machine that sent it.
  machineId?: string;
}

export type JoinStatus = "pending" | "approved" | "denied" | "expired" | "delivered" | "cancelled";

export interface JoinRecord {
  id: string;
  machine: string;
  code: string;
  secretHash: string;
  status: JoinStatus;
  created: number;
  expires: number;
  ended?: number;
  messageIds: string[];
  machineId?: string;
  // Set once the DM of an expired join has been edited.
  cleared?: true;
}

export type MachineStatus = "awaiting-key" | "active" | "removed";

export interface MachineRecord {
  id: string;
  name: string;
  keyHash: string | null;
  status: MachineStatus;
  joined: number;
  lastSeen: number | null;
  removed?: number;
  messageIds: string[];
}

// Every authenticated caller is a joined machine.
export type Principal = { kind: "machine"; id: string; name: string };
