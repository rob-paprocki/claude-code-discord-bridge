function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export type VerifyResult = { ok: true; body: string } | { ok: false };

/** Checks Discord's Ed25519 signature over `timestamp + body`. */
export async function verifyDiscordRequest(
  req: Request,
  publicKeyHex: string,
): Promise<VerifyResult> {
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return { ok: false };

  const sigBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex);
  if (!sigBytes || !keyBytes) return { ok: false };

  const body = await req.text();
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      sigBytes,
      new TextEncoder().encode(timestamp + body),
    );
    return valid ? { ok: true, body } : { ok: false };
  } catch {
    return { ok: false };
  }
}
