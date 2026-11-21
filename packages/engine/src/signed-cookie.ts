const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url");
  }
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
  if (encodeBase64Url(bytes) !== value) {
    throw new Error("Non-canonical base64url");
  }
  return bytes;
}

export function decodeJson(value: string): unknown {
  return JSON.parse(decoder.decode(decodeBase64Url(value)));
}

function importKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", 0);
}

export async function signCookie(
  name: string,
  claims: object,
  secret: string,
  maxAge: number,
): Promise<string> {
  const payload = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        ...claims,
        exp: Math.floor(Date.now() / 1000) + maxAge,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret, "sign"),
    encoder.encode(`${name}.${payload}`),
  );
  return serializeCookie(
    name,
    `${payload}.${encodeBase64Url(new Uint8Array(signature))}`,
    maxAge,
  );
}

export async function readSignedCookie(
  request: Request,
  name: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!cookie || cookie.length > 4096) return null;

  const parts = cookie.slice(name.length + 1).split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret, "verify"),
      decodeBase64Url(signature),
      encoder.encode(`${name}.${payload}`),
    );
    if (!valid) return null;

    const claims = decodeJson(payload);
    if (
      !claims ||
      typeof claims !== "object" ||
      !("exp" in claims) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
