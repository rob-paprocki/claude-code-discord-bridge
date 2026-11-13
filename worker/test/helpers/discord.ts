export function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function publicKeyHex(keyPair: CryptoKeyPair): Promise<string> {
  return bytesToHex((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer);
}

export async function signedInteraction(
  body: object,
  keyPair: CryptoKeyPair,
  url = "https://example.com/discord/interactions",
): Promise<Request> {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    keyPair.privateKey,
    new TextEncoder().encode(timestamp + text),
  );
  return new Request(url, {
    method: "POST",
    headers: {
      "X-Signature-Ed25519": bytesToHex(sig),
      "X-Signature-Timestamp": timestamp,
    },
    body: text,
  });
}
