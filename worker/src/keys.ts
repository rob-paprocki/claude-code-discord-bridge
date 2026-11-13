const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

// XXX-XXX from CODE_ALPHABET. Rejection sampling keeps the characters uniform.
export function joinCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  const bytes = new Uint8Array(8);
  let code = "";
  while (code.length < 6) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && code.length < 6) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// Trimmed name of 1-64 printable ASCII characters (0x20-0x7E), or null.
export function cleanMachineName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return /^[\x20-\x7e]{1,64}$/.test(name) ? name : null;
}
