import { useEffect, useState } from "react";
import { readApi, useAction } from "./workspace-controls";

const subscriptionPath = "/api/push/subscribe";

async function updateSubscription(
  method: "POST" | "DELETE",
  body: PushSubscriptionJSON,
) {
  const response = await fetch(subscriptionPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? "Couldn’t update notifications.");
  }
}

export function PushSettings() {
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
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
      if (controller.signal.aborted) return;
      const existing = await worker.pushManager.getSubscription();
      if (controller.signal.aborted) return;
      setRegistration(worker);
      setSubscription(existing);
      const { publicKey } = await readApi<{ publicKey: string }>(
        "/api/push/key",
        controller.signal,
      );
      if (!controller.signal.aborted) setPublicKey(publicKey);
    }
    void load().catch((error: Error) => {
      if (!controller.signal.aborted) setLoadError(error.message);
    });
    return () => controller.abort();
  }, [supported]);

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

    try {
      await updateSubscription("POST", next.toJSON());
    } catch (error) {
      await next.unsubscribe().catch(() => {});
      throw error;
    }
    setSubscription(next);
    setFeedback("Notifications enabled on this device.");
  }

  async function disable() {
    if (!subscription) return;
    await updateSubscription("DELETE", { endpoint: subscription.endpoint });
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

  function act(action: () => Promise<void>) {
    setFeedback("");
    void run(action);
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
            disabled={busy || (!subscription && !publicKey)}
            onClick={() => act(subscription ? disable : enable)}
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
