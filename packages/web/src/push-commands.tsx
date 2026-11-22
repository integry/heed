import { useEffect, useState } from "react";
import { useApi } from "./api";
import { useAction } from "./workspace-controls";

const subscriptionPath = "/api/push/subscribe";
type Api = ReturnType<typeof useApi>;
let pendingDeviceChange: Promise<string> | undefined;

function requestSubscription<T>(
  api: Api,
  path: string,
  method: "POST" | "DELETE",
  body: PushSubscriptionJSON,
  signal?: AbortSignal,
) {
  return api.requestJson<T>(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
    "Couldn’t check or update notifications.",
  );
}

async function pushRegistration() {
  if (!(
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  ))
    throw new Error(
      "Push notifications are unavailable in this browser. On iOS, open Heed from your Home Screen.",
    );
  const worker = await navigator.serviceWorker.getRegistration();
  if (!worker)
    throw new Error(
      "Push notifications require an installed Heed service worker.",
    );
  return worker.active ? worker : navigator.serviceWorker.ready;
}

async function registeredSubscription(
  api: Api,
  worker: ServiceWorkerRegistration,
  signal?: AbortSignal,
) {
  const device = await worker.pushManager.getSubscription();
  if (!device) return null;
  const { registered } = await requestSubscription<{ registered: boolean }>(
    api,
    "/api/push/status",
    "POST",
    device.toJSON(),
    signal,
  );
  return registered ? device : null;
}

async function changeDevice(action: () => Promise<string>) {
  if (pendingDeviceChange)
    throw new Error("A notification change is already in progress.");
  pendingDeviceChange = action();
  try {
    return await pendingDeviceChange;
  } finally {
    pendingDeviceChange = undefined;
  }
}

export async function runPushCommand(
  api: Api,
  command: "disable notifications" | "test notification",
) {
  async function run() {
    const worker = await pushRegistration();
    const subscription = await registeredSubscription(api, worker);
    if (command === "test notification") {
      if (!subscription)
        throw new Error("Enable notifications on this device first.");
      await worker.showNotification("Heed test notification", {
        body: "Notifications are working on this device.",
        icon: "/icons/heed-192.png",
      });
      return "Test notification shown on this device.";
    }
    if (!subscription)
      return "Notifications are already disabled on this device.";
    await requestSubscription(api, subscriptionPath, "DELETE", {
      endpoint: subscription.endpoint,
    });
    await subscription.unsubscribe();
    return "Notifications disabled on this device.";
  }

  return command === "disable notifications" ? changeDevice(run) : run();
}

export function EnableNotifications({
  finish,
}: {
  finish: (message: string) => void;
}) {
  const api = useApi();
  const { run, busy, error } = useAction();
  const [setup, setSetup] = useState<{
    worker: ServiceWorkerRegistration;
    publicKey: string;
  }>();
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function load() {
      await pendingDeviceChange?.catch(() => {});
      if (signal.aborted) return;
      const worker = await pushRegistration();
      if (await registeredSubscription(api, worker, signal)) {
        if (!signal.aborted)
          setLoadError("Notifications are already enabled on this device.");
        return;
      }
      const { publicKey } = await api.getJson<{ publicKey: string }>(
        "/api/push/key",
        signal,
      );
      if (!signal.aborted) setSetup({ worker, publicKey });
    }
    void load().catch((error: Error) => {
      if (!signal.aborted) setLoadError(error.message);
    });
    return () => controller.abort();
  }, [api]);

  function enable() {
    if (!setup) return;
    void run(async () => {
      const message = await changeDevice(async () => {
        // Safari requires subscribe to start directly in the click handler.
        const subscription = await setup.worker.pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey: setup.publicKey,
          })
          .catch((error: unknown) => {
            if (Notification.permission === "denied")
              throw new Error(
                "Allow notifications for Heed in your browser settings, then try again.",
              );
            throw error;
          });
        await requestSubscription(
          api,
          subscriptionPath,
          "POST",
          subscription.toJSON(),
        );
        return "Notifications enabled on this device.";
      });
      finish(message);
    });
  }

  return (
    <div className="form-stack">
      <p>Get agent handoff notifications on this device.</p>
      {loadError && <p role="status">{loadError}</p>}
      {!setup && !loadError && (
        <p role="status">Checking notification availability…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {setup && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={enable}
        >
          Enable notifications
        </button>
      )}
    </div>
  );
}
