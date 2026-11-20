import {
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
