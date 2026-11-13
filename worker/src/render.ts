import type { OutMessage } from "./discord/rest";
import type { Answer, Question, RequestRecord } from "./types";

const MAX_CONTENT = 2000;
const SPLIT_AT = 1990;
const MAX_ROWS = 5;
const PREVIEW_MAX = 1200;
const QUESTION_TEXT_MAX = 1000;
const DESCRIPTION_MAX = 300;
const ALWAYS_MAX = 300;
const FIELD_MAX = 80;
const OUTCOME_MAX = 500;
const MIN_OUTCOME = 40;
const MAX_PARTS = 3;
const CUT_LINE = "… (cut; the full reply is in the terminal)";

export const BUTTON_PRIMARY = 1;
export const BUTTON_SECONDARY = 2;
export const BUTTON_SUCCESS = 3;
export const BUTTON_DANGER = 4;

// Escape user-supplied text so it cannot add Markdown, links or mentions.
export function esc(s: string, max = FIELD_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut.replace(/[\\`*_~|>#[\]()<@]/g, "\\$&");
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Discord only knows ``` fences and closes the block at the next ```, so no run of two or more
// backticks may survive inside: a zero-width space between neighbours breaks every run.
function fenced(text: string): string {
  const safe = text.replace(/`{2,}/g, (run) => run.split("").join("\u200b"));
  return `\`\`\`\n${safe}\n\`\`\``;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function label(r: RequestRecord): string {
  switch (r.kind) {
    case "permission":
      return r.tool ? `Needs your OK: ${esc(r.tool)}` : "Needs your OK";
    case "question":
      return "Question";
    case "stop":
      if (r.mode === "turn") return "Claude replied";
      return r.elapsedSeconds === undefined ? "Done" : `Done after ${duration(r.elapsedSeconds)}`;
    case "notify":
      if (r.event === "StopFailure") return `Stopped by an error (${esc(r.event)})`;
      if (r.event === "PermissionDenied") return r.tool ? `Auto mode blocked ${esc(r.tool)}` : "Auto mode blocked a tool";
      if (r.event === "AskUserQuestion") return "Claude is asking";
      return "A background session needs input";
  }
}

function firstLine(r: RequestRecord): string {
  const where = [r.machine, r.project, r.title || r.session.slice(0, 8)].map((f) => esc(f)).join(" · ");
  return `**${label(r)}** · ${where}`;
}

export function button(style: number, text: string, customId: string): object {
  return { type: 2, style, label: clip(text, FIELD_MAX), custom_id: customId };
}

function row(...components: object[]): object {
  return { type: 1, components };
}

function backButton(r: RequestRecord): object {
  return button(BUTTON_SECONDARY, "Back to terminal", `b:${r.id}:back`);
}

// The options ticked for a multi-select question. The stored string is the chosen labels joined
// with ", " in option order. A label may itself contain ", " or be a prefix of another, so this
// searches for a full parse (each taken label followed by ", " or the end) and backtracks; the
// first parse in option order wins.
export function tickedLabels(q: Question, stored: string): Set<string> {
  const failed = new Set<string>();
  const parse = (index: number, pos: number): string[] | null => {
    if (pos === stored.length) return [];
    if (index >= q.options.length) return null;
    const key = `${index}:${pos}`;
    if (failed.has(key)) return null;
    const label = q.options[index].label;
    const end = pos + label.length;
    if (stored.startsWith(label, pos) && (end === stored.length || stored.startsWith(", ", end))) {
      const rest = parse(index + 1, end === stored.length ? end : end + 2);
      if (rest) return [label, ...rest];
    }
    const skipped = parse(index + 1, pos);
    if (skipped) return skipped;
    failed.add(key);
    return null;
  };
  return new Set(stored === "" ? [] : (parse(0, 0) ?? []));
}

function isChosen(r: RequestRecord, q: Question, label: string): boolean {
  const stored = r.partial?.[q.question];
  if (stored === undefined) return false;
  return q.multiSelect ? tickedLabels(q, stored).has(label) : stored === label;
}

function questionRows(r: RequestRecord, questions: Question[]): object[] {
  const rows: object[] = [];
  questions.slice(0, MAX_ROWS - 1).forEach((q, qi) => {
    if (q.multiSelect) {
      rows.push(
        row({
          type: 3,
          custom_id: `s:${r.id}:${qi}`,
          placeholder: clip(q.header || q.question, 100),
          min_values: 1,
          max_values: Math.min(q.options.length, 25),
          options: q.options.slice(0, 25).map((o, oi) => ({
            label: clip(o.label, 100),
            value: String(oi),
            ...(isChosen(r, q, o.label) ? { default: true } : {}),
            ...(o.description ? { description: clip(o.description, 100) } : {}),
          })),
        }),
      );
    } else {
      rows.push(
        row(
          ...q.options.slice(0, 5).map((o, oi) =>
            isChosen(r, q, o.label)
              ? button(BUTTON_SUCCESS, `✓ ${o.label}`, `b:${r.id}:opt:${qi}:${oi}`)
              : button(BUTTON_PRIMARY, o.label, `b:${r.id}:opt:${qi}:${oi}`),
          ),
        ),
      );
    }
  });
  rows.push(
    row(
      button(BUTTON_SUCCESS, "Answer…", `b:${r.id}:answer`),
      button(BUTTON_SECONDARY, "Chat…", `b:${r.id}:chat`),
      backButton(r),
    ),
  );
  return rows;
}

function components(r: RequestRecord): object[] | undefined {
  switch (r.kind) {
    case "permission":
      return [
        row(
          button(BUTTON_SUCCESS, "Allow", `b:${r.id}:allow`),
          ...(r.always ? [button(BUTTON_SUCCESS, "Always allow", `b:${r.id}:always`)] : []),
          button(BUTTON_PRIMARY, "Switch to auto mode", `b:${r.id}:auto`),
          button(BUTTON_DANGER, "Deny", `b:${r.id}:deny`),
          backButton(r),
        ),
      ];
    case "question":
      return questionRows(r, r.questions ?? []);
    case "stop": {
      const reply = button(BUTTON_PRIMARY, "Reply…", `b:${r.id}:reply`);
      return [row(...(r.mode === "turn" ? [reply, backButton(r)] : [reply]))];
    }
    case "notify":
      return undefined;
  }
}

function questionText(questions: Question[]): string {
  return questions
    .map((q, qi) => {
      const head = q.header ? `${esc(q.header)}: ` : "";
      const opts = q.options
        .map((o) => `• ${esc(o.label)}${o.description ? ` (${esc(o.description, DESCRIPTION_MAX)})` : ""}`)
        .join("\n");
      return `${qi + 1}. ${head}${esc(q.question, QUESTION_TEXT_MAX)}${q.multiSelect ? " (pick any)" : ""}\n${opts}`;
    })
    .join("\n");
}

function body(r: RequestRecord): string {
  switch (r.kind) {
    case "permission": {
      const covers = r.always ? `Always allow will: ${esc(r.always, ALWAYS_MAX)}` : "";
      const preview = r.preview ?? "";
      if (!preview) return covers;
      let shown = fenced(preview);
      if (preview.length > PREVIEW_MAX) {
        let cut = preview.slice(0, PREVIEW_MAX);
        if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
        shown = `${fenced(cut)}\n⚠ Preview cut at ${PREVIEW_MAX} of ${preview.length} characters; the full command is in the terminal.`;
      }
      return covers ? `${shown}\n${covers}` : shown;
    }
    case "question":
      return questionText(r.questions ?? []);
    case "notify":
      // A question sent as a heads-up only (BRIDGE_QUESTIONS=notify): it is answered elsewhere.
      if (r.event === "AskUserQuestion") return `${questionText(r.questions ?? [])}\nAnswer in the terminal or the Claude app.`;
      return r.text ?? "";
    case "stop":
      return r.text ?? "";
  }
}

const FENCE_LINE = /^\s*```(.*)$/;
const INFO_MAX = 100;

// A fence line opens or closes a block. A line like ```npm test``` closes itself on the same line,
// so it toggles nothing.
function fenceInfo(line: string): string | null {
  const m = FENCE_LINE.exec(line);
  return m && !m[1].includes("```") ? m[1] : null;
}

// Whether text ends inside an open ``` fence.
function endsInFence(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) if (fenceInfo(line) !== null) open = !open;
  return open;
}

// Cuts to at most max characters, never leaving a lone high surrogate at the end.
function cutSafe(s: string, max: number): string {
  const cut = s.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// The fence state after text, given the state before it.
function advance(state: { inFence: boolean; info: string }, text: string): { inFence: boolean; info: string } {
  let { inFence, info } = state;
  for (const line of text.split("\n")) {
    const lineInfo = fenceInfo(line);
    if (lineInfo === null) continue;
    inFence = !inFence;
    info = inFence ? cutSafe(lineInfo.trim(), INFO_MAX) : "";
  }
  return { inFence, info };
}

// Splits at newlines where it can (hard cut otherwise, never inside a surrogate pair). A part that
// ends inside a ``` fence closes it, and the next part reopens it with the same info string.
export function split(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  let open = "";
  let inFence = false;
  let info = "";
  for (;;) {
    if (open.length + rest.length <= MAX_CONTENT) {
      parts.push(open + rest);
      return parts;
    }
    const limit = SPLIT_AT - open.length;
    let cut: number;
    let skip = 0;
    const nl = rest.lastIndexOf("\n", limit);
    if (nl >= limit / 2) {
      cut = nl;
      skip = 1;
    } else {
      cut = limit;
      if (/[\ud800-\udbff]/.test(rest[cut - 1] ?? "")) cut -= 1;
      // An odd run of backslashes at the cut would leave the last one without its escaped character.
      const slashes = /\\+$/.exec(rest.slice(0, cut))?.[0].length ?? 0;
      if (slashes % 2 === 1 && cut > 1) cut -= 1;
    }
    let chunk = rest.slice(0, cut);
    let state = advance({ inFence, info }, chunk);
    // A cut right after an opening fence line would leave an empty block: the fence opens in the
    // next part instead.
    const lastStart = chunk.lastIndexOf("\n") + 1;
    if (lastStart > 1 && fenceInfo(chunk.slice(lastStart)) !== null && state.inFence && !advance({ inFence, info }, chunk.slice(0, lastStart - 1)).inFence) {
      cut = lastStart - 1;
      skip = 1;
      chunk = rest.slice(0, cut);
      state = advance({ inFence, info }, chunk);
    }
    // If the next part would start with this block's closing fence line, that line stays here.
    if (state.inFence && skip === 1) {
      const end = rest.indexOf("\n", cut + 1);
      const line = rest.slice(cut + 1, end < 0 ? undefined : end);
      if (end >= 0 && fenceInfo(line) !== null && open.length + end <= MAX_CONTENT) {
        cut = end;
        chunk = rest.slice(0, cut);
        state = { inFence: false, info: "" };
      }
    }
    inFence = state.inFence;
    info = state.info;
    parts.push(open + chunk + (inFence ? "\n```" : ""));
    open = inFence ? `\`\`\`${info}\n` : "";
    rest = rest.slice(cut + skip);
  }
}

// Trim the last kept part to make room for CUT_LINE: never end on a lone high
// surrogate, and re-close a code fence the trim left open.
function cutPart(part: string): string {
  let kept = part.slice(0, MAX_CONTENT - CUT_LINE.length - 1 - "\n```".length);
  if (/[\ud800-\udbff]/.test(kept[kept.length - 1] ?? "")) kept = kept.slice(0, -1);
  return `${kept}${endsInFence(kept) ? "\n```" : ""}\n${CUT_LINE}`;
}

export function renderRequest(r: RequestRecord): OutMessage[] {
  const content = [firstLine(r), body(r)].filter(Boolean).join("\n");
  let parts = split(content);
  if ((r.kind === "stop" || r.kind === "notify") && parts.length > MAX_PARTS) {
    parts = [...parts.slice(0, MAX_PARTS - 1), cutPart(parts[MAX_PARTS - 1])];
  }
  const comps = components(r);
  return parts.map((part, i) => (comps && i === parts.length - 1 ? { content: part, components: comps } : { content: part }));
}

// Plain outcome text; withOutcome escapes it.
export function orderedAnswers(answers: Record<string, string>, questions?: Question[]): [string, string][] {
  const known = (questions ?? []).filter((q) => q.question in answers).map((q) => q.question);
  const rest = Object.keys(answers).filter((k) => !known.includes(k));
  return [...known, ...rest].map((k) => [k, answers[k]]);
}

export function permissionOutcome(a: { behavior: "allow" | "deny"; scope?: "always" | "auto" }): string {
  if (a.behavior === "deny") return "Denied";
  if (a.scope === "always") return "Allowed, and won't ask again";
  if (a.scope === "auto") return "Allowed, and switched to auto mode";
  return "Allowed";
}

function describeAnswer(a: Answer, questions?: Question[]): string {
  if ("behavior" in a) return permissionOutcome(a);
  switch (a.type) {
    case "answers":
      return `Answered: ${orderedAnswers(a.answers, questions).map(([q, v]) => `${q} → ${v}`).join("; ")}`;
    case "text":
      return `Answered: ${a.text}`;
    case "chat":
      return `Chat: ${a.text}`;
    case "back":
      return "Back to terminal";
  }
}

export function outcomeLine(r: RequestRecord): string {
  switch (r.status) {
    case "answered":
      return r.answer ? describeAnswer(r.answer, r.questions) : "Answered";
    case "released":
      if (r.answer && "type" in r.answer && r.answer.type === "back") return "Back to terminal";
      // Handed back: whether it was then answered there is not known here.
      return "Back at the terminal.";
    case "expired":
      return r.kind === "stop" && r.mode === "done" ? "Reply window closed." : "Expired. Answer in the terminal.";
    default:
      return "";
  }
}

// The message body with an outcome line under it and no buttons. The outcome is escaped and cut to
// the room the body leaves. Only a body that leaves less than MIN_OUTCOME gives way, so the outcome
// stays readable.
export function withOutcome(body: string, outcome: string): string {
  const line = esc(outcome, OUTCOME_MAX);
  if (!line) return body;
  const room = MAX_CONTENT - body.length - 1;
  const shown = clip(line, Math.max(room, Math.min(line.length, MIN_OUTCOME)));
  const bodyRoom = MAX_CONTENT - shown.length - 1;
  if (body.length <= bodyRoom) return `${body}\n${shown}`;
  // The body gives way: cut it surrogate-safely, and close a fence the cut leaves open.
  let kept = cutSafe(body, bodyRoom - 1);
  let close = "";
  if (endsInFence(kept)) {
    kept = cutSafe(body, bodyRoom - 1 - "\n```".length);
    close = endsInFence(kept) ? "\n```" : "";
  }
  return `${kept}…${close}\n${shown}`;
}

// Edits of an already-sent DM keep its text (the last part, which carries the buttons).
export function renderOutcome(r: RequestRecord, outcome: string = outcomeLine(r)): OutMessage {
  const last = renderRequest(r).at(-1);
  return { content: withOutcome(last?.content ?? firstLine(r), outcome) };
}
