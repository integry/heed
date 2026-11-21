import { encodeBase64Url } from "./signed-cookie";

const encoder = new TextEncoder();

export function newTokenSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isTokenSecret(secret: string): boolean {
  // For 32 bytes, the final base64url character has two zero padding bits.
  return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(secret);
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return encodeBase64Url(new Uint8Array(digest));
}

export function equalSecretHashes(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    crypto.subtle.timingSafeEqual(leftBytes, rightBytes)
  );
}
