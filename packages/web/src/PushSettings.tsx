import { useApi } from "./api";
import { useEffect, useState } from "react";
import { useAction } from "./workspace-controls";

const subscriptionPath = "/api/push/subscribe";
let pendingDeviceChange: Promise<void> | undefined;

async function requestSubscription<T>(
  requestJson: ReturnType<typeof useApi>["requestJson"],
  path: string,
  method: "POST" | "DELETE",
  body: PushSubscriptionJSON,
  errorMessage: string,
  signal?: AbortSignal,
) {
  return requestJson<T>(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    errorMessage,
  );
}

async function registeredSubscription(
  requestJson: ReturnType<typeof useApi>["requestJson"],
  subscription: PushSubscription,
  signal?: AbortSignal,
) {
  const { registered } = await requestSubscription<{ registered: boolean }>(
    requestJson,
    "/api/push/status",
    "POST",
    subscription.toJSON(),
    "Couldn’t check notification registration.",
    signal,
  );
  return registered ? subscription : null;
}

function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function readPushSubscription(
  worker: ServiceWorkerRegistration,
  requestJson: ReturnType<typeof useApi>["requestJson"],
  signal: AbortSignal,
) {
  // Settings can be closed while a device change is still in progress.
  await pendingDeviceChange?.catch(() => {});
  if (signal.aborted) return null;
  const existing = await worker.pushManager.getSubscription();
  return !signal.aborted && existing
    ? registeredSubscription(requestJson, existing, signal)
    : null;
}

export function PushSettings() {
  const { getJson, requestJson } = useApi();
  const supported = pushSupported();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [publicKey, setPublicKey] = useState<string>();
  const [subscription, setSubscription] = useState<PushSubscription | null>();
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState("");
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    async function load() {
      const worker = await navigator.serviceWorker.ready;
      const registered = await readPushSubscription(
        worker,
        requestJson,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRegistration(worker);
      setSubscription(registered);
      const { publicKey } = await getJson<{ publicKey: string }>(
        "/api/push/key",
        controller.signal,
      );
      if (!controller.signal.aborted) setPublicKey(publicKey);
    }
    void load().catch((error: Error) => {
      if (!controller.signal.aborted) setLoadError(error.message);
    });
    return () => controller.abort();
  }, [getJson, requestJson, supported]);

  async function updateSubscription(
    method: "POST" | "DELETE",
    device: PushSubscription,
  ) {
    try {
      await requestSubscription(
        requestJson,
        subscriptionPath,
        method,
        method === "POST" ? device.toJSON() : { endpoint: device.endpoint },
        "Couldn’t update notifications.",
      );
    } catch (error) {
      // A lost response does not tell us whether the server committed the change.
      setSubscription(undefined);
      setSubscription(
        await registeredSubscription(requestJson, device).catch(
          () => undefined,
        ),
      );
      throw error;
    }
  }

  async function enable() {
    if (!registration || !publicKey) return;
    // Start the browser permission flow directly from the click. Safari
    // requires a user gesture to request a push subscription.
    const next = await registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      })
      .catch((error: unknown) => {
        if (Notification.permission === "denied")
          throw new Error(
            "Allow notifications for Heed in your browser settings, then try again.",
          );
        throw error;
      });

    await updateSubscription("POST", next);
    setSubscription(next);
    setFeedback("Notifications enabled on this device.");
  }

  async function disable() {
    if (!subscription) return;
    await updateSubscription("DELETE", subscription);
    // The server is already unsubscribed. If browser cleanup fails, enabling
    // again can register the same subscription.
    setSubscription(null);
    await subscription.unsubscribe();
    setFeedback("Notifications disabled on this device.");
  }

  async function testNotification() {
    if (!registration) return;
    await registration.showNotification("Heed test notification", {
      body: "Notifications are working on this device.",
      icon: "/icons/heed-192.png",
    });
    setFeedback("Test notification shown on this device.");
  }

  function act(action: () => Promise<void>, changesDevice = false) {
    setFeedback("");
    void run(async () => {
      if (!changesDevice) return action();
      if (pendingDeviceChange) return;
      const change = action();
      pendingDeviceChange = change;
      try {
        await change;
      } finally {
        pendingDeviceChange = undefined;
      }
    });
  }

  return (
    <section className="settings-section" aria-labelledby="push-heading">
      <h3 id="push-heading">Notifications</h3>
      <p className="muted">Get agent handoff notifications on this device.</p>
      <p className="muted">
        On iOS, add Heed to your Home Screen and open it from there first.
      </p>
      {supported ? (
        <div className="inline-actions">
          <button
            type="button"
            className={subscription ? "subtle" : "primary"}
            disabled={
              busy ||
              subscription === undefined ||
              (!subscription && !publicKey)
            }
            onClick={() => act(subscription ? disable : enable, true)}
          >
            {subscription ? "Disable notifications" : "Enable notifications"}
          </button>
          <button
            type="button"
            className="subtle"
            disabled={busy || !subscription}
            onClick={() => act(testNotification)}
          >
            Send test notification
          </button>
        </div>
      ) : (
        <p className="muted">
          Push notifications are unavailable in this browser.
        </p>
      )}
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
