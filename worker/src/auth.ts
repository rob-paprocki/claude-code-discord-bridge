import type { Bridge } from "./bridge";
import { sha256Hex } from "./keys";
import type { Principal } from "./types";

function bearer(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

// Who is calling: the bearer is hashed here and looked up as a machine key. The plain key never
// reaches the Durable Object. Null means 401.
export async function authenticate(
  req: Request,
  bridge: DurableObjectStub<Bridge>,
): Promise<Principal | null> {
  const token = bearer(req);
  if (!token) return null;
  const machine = await bridge.machineByKeyHash(await sha256Hex(token));
  return machine ? { kind: "machine", id: machine.id, name: machine.name } : null;
}
