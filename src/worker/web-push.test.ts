import { encryptNotification } from "@block65/webcrypto-web-push";
import type { PushSubscription } from "@block65/webcrypto-web-push";
import { expect, it, vi } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "./signed-cookie";

it("matches the RFC 8291 section 5 aes128gcm payload byte for byte", async () => {
  const receiver: PushSubscription = {
    endpoint: "https://push.example.net/push/example",
    expirationTime: null,
    keys: {
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    },
  };
  const sender = decodeBase64Url(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const keys = {
    publicKey: await crypto.subtle.importKey("raw", sender, curve, true, []),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: encodeBase64Url(sender.slice(1, 33)),
        y: encodeBase64Url(sender.slice(33)),
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      },
      curve,
      false,
      ["deriveBits"],
    ),
  };
  const salt = decodeBase64Url("DGv6ra1nlYgDCS1FRnbzlw");
  const generateKey = vi
    .spyOn(crypto.subtle, "generateKey")
    .mockResolvedValueOnce(keys);
  const random = vi.spyOn(crypto, "getRandomValues").mockReturnValueOnce(salt);
  try {
    const plaintext = new TextEncoder().encode(
      "When I grow up, I want to be a watermelon",
    );
    const payload = await encryptNotification(receiver, plaintext, {
      pad: false,
    });
    expect(encodeBase64Url(payload)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  } finally {
    generateKey.mockRestore();
    random.mockRestore();
  }
});
