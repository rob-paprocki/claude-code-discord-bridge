import type { Bridge } from "./bridge";
import type { JoinRecord, MachineRecord } from "./types";
import { runEdits, runMessageEdits } from "./dm";
import type { Env } from "./env";
import { MSG_GONE, MSG_HANDLED, MSG_STRANGER, refuse, staleUpdate } from "./replies";
import type { Config } from "./setup-row";
import { type DiscordInteraction, isAllowedUser } from "./users";
import { confirmRemoveRow, nameSpan, removeRow, renderJoinState, renderMachineList, SUPPRESS_EMBEDS } from "./render-join";

// A message as a type 7 (update the pressed message) response.
function update(message: { content: string; components?: object[] }): Response {
  return Response.json({
    type: 7,
    data: { content: message.content, components: message.components ?? [], flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } },
  });
}

// A press on a join or machine message that can no longer act: the message shows the state it is
// in now and loses any button that no longer applies. Unknown ids keep the text and lose the buttons.
function staleJoin(original: string, found: { join: JoinRecord; machine?: MachineRecord } | null): Response {
  return found ? update(renderJoinState(found.join, found.machine)) : update({ content: original });
}

async function staleMachine(bridge: DurableObjectStub<Bridge>, machineId: string, original: string): Promise<Response> {
  const m = await bridge.machine(machineId);
  if (!m) return staleUpdate(original, MSG_GONE);
  const join = await bridge.joinOfMachine(machineId);
  return join ? update(renderJoinState(join, m)) : update({ content: `**Removed** · ${nameSpan(m.name)}` });
}

function bridgeStub(env: Env): DurableObjectStub<Bridge> {
  return env.BRIDGE.get(env.BRIDGE.idFromName("bridge")) as DurableObjectStub<Bridge>;
}

// Slash commands (interaction type 2). Only /machines exists; the answer is ephemeral.
export async function handleCommand(i: DiscordInteraction, env: Env, config: Config): Promise<Response> {
  if (!isAllowedUser(i, config.allowed)) return refuse(MSG_STRANGER);
  if (i.data?.name !== "machines") return refuse(MSG_HANDLED);
  const list = renderMachineList(await bridgeStub(env).listMachines());
  return Response.json({ type: 4, data: { ...list, flags: 64 | SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } } });
}

// The /machines list buttons: ml:<machineId>:remove|confirm|cancel. The list is ephemeral, so
// every press updates it in place (type 7).
async function handleListButton(env: Env, ctx: ExecutionContext, id: string, action: string): Promise<Response> {
  const bridge = bridgeStub(env);
  let confirming: string | undefined;
  if (action === "confirm") {
    const r = await bridge.removeMachine(id);
    runEdits(env, ctx, r.edits);
    runMessageEdits(env, ctx, r.messageEdits);
  } else if (action === "remove") {
    confirming = id;
  }
  return update(renderMachineList(await bridge.listMachines(), confirming));
}

// Join and machine buttons: j:<joinId>:approve|deny, mc:<machineId>:remove|confirm|cancel, ml: for /machines.
export async function handleJoinInteraction(i: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const userId = i.member?.user?.id ?? i.user?.id ?? "";
  const [prefix, id, action] = (i.data?.custom_id ?? "").split(":");
  const bridge = bridgeStub(env);
  const pressed = `${i.message?.channel_id ?? i.channel_id ?? ""}:${i.message?.id ?? ""}`;
  const others = (ids: string[]) => ids.filter((m) => m !== pressed);

  if (i.type === 3 && prefix === "ml" && id && (action === "remove" || action === "confirm" || action === "cancel")) {
    return handleListButton(env, ctx, id, action);
  }

  if (i.type === 3 && prefix === "mc" && id && (action === "remove" || action === "confirm" || action === "cancel")) {
    if (action === "confirm") {
      const r = await bridge.removeMachine(id);
      if (!r.removed) return staleMachine(bridge, id, i.message?.content ?? "");
      runEdits(env, ctx, r.edits);
      // The pressed message is answered by this response; the other copies are edited.
      runMessageEdits(env, ctx, r.messageEdits.map((e) => ({ ...e, messageIds: others(e.messageIds) })));
      return update(r.messageEdits[0]?.message ?? { content: "**Removed**", flags: SUPPRESS_EMBEDS });
    }
    const m = await bridge.machine(id);
    if (!m) return staleUpdate(i.message?.content ?? "", MSG_GONE);
    if (m.status === "removed") return staleMachine(bridge, id, i.message?.content ?? "");
    const content = i.message?.content ?? "";
    return update({ content, components: action === "remove" ? confirmRemoveRow(id, m.name) : removeRow(id) });
  }

  if (i.type !== 3 || prefix !== "j" || !id || (action !== "approve" && action !== "deny")) return refuse(MSG_HANDLED);

  if (action === "approve") {
    const r = await bridge.approveJoin(id, userId);
    if (r.result === "forbidden") return refuse(MSG_STRANGER);
    if (r.result !== "ok" || !r.join || !r.machine) return staleJoin(i.message?.content ?? "", await bridge.joinById(id));
    const state = renderJoinState(r.join, r.machine);
    // The other copies lose their buttons; only the pressed message keeps Remove.
    runMessageEdits(env, ctx, [{ messageIds: others(r.join.messageIds), message: { content: state.content, flags: SUPPRESS_EMBEDS } }]);
    return update(state);
  }

  const r = await bridge.denyJoin(id, userId);
  if (r.result === "forbidden") return refuse(MSG_STRANGER);
  if (r.result !== "ok" || !r.join) return staleJoin(i.message?.content ?? "", await bridge.joinById(id));
  const state = renderJoinState(r.join);
  runMessageEdits(env, ctx, [{ messageIds: others(r.join.messageIds), message: state }]);
  return update(state);
}
