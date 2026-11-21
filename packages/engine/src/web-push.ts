import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription, VapidKeys } from "@block65/webcrypto-web-push";
import { z } from "zod";
import { decodeBase64Url } from "./signed-cookie.js";

export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  PUSH_RATE_LIMIT_PER_HOUR?: string;
}

// A subscription supplies an outbound URL. Restrict delivery to browser push
// providers and disallow redirects so it can't become an arbitrary HTTP request.
const endpoint = z
  .url({ protocol: /^https$/ })
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    const host = url.hostname;
    return (
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com" ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".notify.windows.com"))
    );
  }, "Unsupported browser push endpoint");

function key(length: number, firstByte?: number) {
  return z
    .base64url()
    .length(Math.ceil((length * 8) / 6))
    .refine((value) => {
      try {
        const bytes = decodeBase64Url(value);
        return (
          bytes.length === length &&
          (firstByte === undefined || bytes[0] === firstByte)
        );
      } catch {
        return false;
      }
    }, "Invalid push key");
}

export const PushEndpointSchema = z.object({ endpoint });
export const PushSubscriptionSchema = PushEndpointSchema.extend({
  keys: z.object({ p256dh: key(65, 4), auth: key(16) }),
});

export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;

export type HandoffPush = {
  title: string;
  body: string;
  url: string;
};

export function vapidKeys(env: PushEnv): VapidKeys | undefined {
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = env;
  if (publicKey && privateKey && subject)
    return { publicKey, privateKey, subject };
}

export function preparePush(
  data: HandoffPush,
  subscription: PushSubscription,
  vapid: VapidKeys,
) {
  return buildPushPayload(
    { data, options: { ttl: 3600 } },
    subscription,
    vapid,
  );
}
