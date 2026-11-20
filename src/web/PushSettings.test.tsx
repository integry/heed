import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PushSettings } from "./PushSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("uses the browser subscription flow, then sends a local test and disables the device", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/test-device";
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { auth: "auth", p256dh: "p256dh" } }),
    unsubscribe: vi.fn(async () => true),
  };
  const subscribe = vi.fn(async () => subscription);
  const showNotification = vi.fn(async () => {});
  const registration = {
    pushManager: { getSubscription: async () => null, subscribe },
    showNotification,
  };
  vi.stubGlobal("navigator", {
    serviceWorker: { ready: Promise.resolve(registration) },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "default" });
  const fetch = vi.fn(async (path: string) =>
    Response.json(
      path === "/api/push/key" ? { publicKey: "vapid-key" } : { ok: true },
    ),
  );
  vi.stubGlobal("fetch", fetch);

  render(<PushSettings />);
  const enable = screen.getByRole<HTMLButtonElement>("button", {
    name: "Enable notifications",
  });
  const test = screen.getByRole<HTMLButtonElement>("button", {
    name: "Send test notification",
  });
  expect(test.disabled).toBe(true);
  await waitFor(() => expect(enable.disabled).toBe(false));
  fireEvent.click(enable);
  expect(subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: "vapid-key",
  });
  await screen.findByRole("button", { name: "Disable notifications" });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/push/subscribe",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    }),
  );

  fireEvent.click(test);
  await screen.findByText("Test notification shown on this device.");
  expect(showNotification).toHaveBeenCalledWith(
    "Heed test notification",
    expect.any(Object),
  );
  expect(fetch).toHaveBeenCalledTimes(2);

  fireEvent.click(
    screen.getByRole("button", { name: "Disable notifications" }),
  );
  await screen.findByText("Notifications disabled on this device.");
  expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/push/subscribe",
    expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
  );
});

function survivingSubscription(initiallyRegistered: boolean) {
  let registered = initiallyRegistered;
  const endpoint = "https://fcm.googleapis.com/fcm/send/surviving-device";
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { auth: "auth", p256dh: "p256dh" } }),
    unsubscribe: vi.fn<() => Promise<boolean>>(),
  };
  const getSubscription = vi.fn(async () => subscription);
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { getSubscription, subscribe: async () => subscription },
      }),
    },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "granted" });
  let rejectResponse = false;
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === "/api/push/key") return Response.json({ publicKey: "key" });
    if (path === "/api/push/status") {
      expect(options.body).toBe(JSON.stringify(subscription.toJSON()));
      return Response.json({ registered });
    }
    expect(path).toBe("/api/push/subscribe");
    registered = options.method === "POST";
    if (rejectResponse) throw new Error("Connection lost");
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    subscription,
    getSubscription,
    fetch,
    loseMutationResponse: () => (rejectResponse = true),
  };
}

function notificationButton(name: string) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

it.each([false, true])(
  "recovers a surviving browser subscription after server deletion (reopen during cleanup: %s)",
  async (reopenDuringCleanup) => {
    const { subscription, getSubscription, fetch } =
      survivingSubscription(true);
    let rejectCleanup!: (error: Error) => void;
    subscription.unsubscribe.mockImplementation(
      () => new Promise((_, reject) => (rejectCleanup = reject)),
    );
    const settings = render(<PushSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Disable notifications" }),
    );
    await waitFor(() =>
      expect(subscription.unsubscribe).toHaveBeenCalledOnce(),
    );

    if (reopenDuringCleanup) {
      settings.unmount();
      render(<PushSettings />);
      await act(async () => {});
      expect(notificationButton("Enable notifications").disabled).toBe(true);
      expect(getSubscription).toHaveBeenCalledOnce();
      rejectCleanup(new Error("Browser cleanup failed"));
    } else {
      rejectCleanup(new Error("Browser cleanup failed"));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Browser cleanup failed",
      );
      settings.unmount();
      render(<PushSettings />);
    }

    const enable = notificationButton("Enable notifications");
    await waitFor(() => expect(enable.disabled).toBe(false));
    expect(notificationButton("Send test notification").disabled).toBe(true);
    expect(getSubscription).toHaveBeenCalledTimes(2);
    fireEvent.click(enable);
    await screen.findByRole("button", { name: "Disable notifications" });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/push/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(subscription.toJSON()),
      }),
    );
    expect(notificationButton("Send test notification").disabled).toBe(false);
  },
);

it.each([
  [false, "Enable notifications", "Disable notifications"],
  [true, "Disable notifications", "Enable notifications"],
] as const)(
  "checks server registration after a committed change loses its response (initially registered: %s)",
  async (registered, before, after) => {
    const { subscription, loseMutationResponse } =
      survivingSubscription(registered);
    loseMutationResponse();
    render(<PushSettings />);
    await waitFor(() =>
      expect(notificationButton(before).disabled).toBe(false),
    );
    fireEvent.click(notificationButton(before));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Connection lost",
    );
    expect(notificationButton(after).disabled).toBe(false);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  },
);
