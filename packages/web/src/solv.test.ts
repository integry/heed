import { afterEach, expect, it, vi } from "vitest";
import { connectSolv } from "./solv";

let credentialSupported = true;
let sendSupported = true;
const setToolCredential = vi.fn();
const send = vi.fn().mockResolvedValue({ text: "Here is the reply." });
const open = vi.fn();
const controllers: AbortController[] = [];

function connect(suffix: string, workspaceId = "first") {
  const controller = new AbortController();
  controllers.push(controller);
  const requestToken = vi
    .fn()
    .mockResolvedValueOnce({
      access_token: "initial",
      expires_in: 900,
      workspace_id: workspaceId,
      user_id: "test",
    })
    .mockResolvedValue({
      access_token: "renewed",
      expires_in: 900,
      workspace_id: workspaceId,
      user_id: "test",
    });
  const assistant = connectSolv(
    {
      widgetUrl: `https://chat.example.test/${suffix}.js`,
      assistantKey: "example",
    },
    {
      workspaceId,
      userId: "test",
      requestToken,
      signal: controller.signal,
      view: {
        selectItem: vi.fn(),
        zoomBand: vi.fn(),
        switchLens: vi.fn(),
        openGuidance: vi.fn(),
      },
      focusLine: vi.fn(),
    },
  );
  return { ...assistant, requestToken, controller };
}

function script(suffix: string) {
  return document.querySelector(`script[src$="/${suffix}.js"]`)!;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.head.querySelectorAll("script").forEach((node) => node.remove());
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  credentialSupported = true;
  sendSupported = true;
});

it("waits for the custom element, hands off and renews the credential, and sends without opening chat", async () => {
  vi.useFakeTimers();
  const assistant = connect("current");
  script("current").dispatchEvent(new Event("load"));
  await Promise.resolve();
  expect(assistant.requestToken).not.toHaveBeenCalled();
  customElements.define(
    "solv-chat",
    class extends HTMLElement {
      setToolCredential = credentialSupported ? setToolCredential : undefined;
      send = sendSupported ? send : undefined;
      open = open;
    },
  );

  expect(await assistant.send("What should I focus on?")).toBe(
    "Here is the reply.",
  );
  expect(assistant.requestToken).toHaveBeenCalledTimes(1);
  expect(setToolCredential).toHaveBeenCalledWith(
    new URL("/mcp", location.href).href,
    "initial",
  );
  expect(send).toHaveBeenCalledWith("What should I focus on?");
  expect(open).not.toHaveBeenCalled();
  const widget = document.querySelector("solv-chat");
  expect(widget?.getAttribute("assistant")).toBe("example");
  expect(widget?.hasAttribute("hide-launcher")).toBe(true);

  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(setToolCredential).toHaveBeenLastCalledWith(
    new URL("/mcp", location.href).href,
    "renewed",
  );

  sessionStorage.setItem("solv-chat-open:example", "old transcript");
  assistant.controller.abort();
  expect(widget?.isConnected).toBe(false);
  expect(setToolCredential).toHaveBeenLastCalledWith(
    new URL("/mcp", location.href).href,
    null,
  );
  const nextWorkspace = connect("current", "second");
  await nextWorkspace.open();
  expect(sessionStorage.getItem("solv-chat-open:example")).toBeNull();
  expect(nextWorkspace.requestToken).toHaveBeenCalledTimes(1);
  expect(
    document.head.querySelectorAll('script[src$="/current.js"]'),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(assistant.requestToken).toHaveBeenCalledTimes(2);
});

it("opens the focused side panel when the widget has credentials but no send method", async () => {
  sendSupported = false;
  const assistant = connect("no-send");
  script("no-send").dispatchEvent(new Event("load"));
  await assistant.send("What should I focus on?");
  expect(open).toHaveBeenCalledWith({ mode: "side", focus: true });
  expect(send).not.toHaveBeenCalled();
});

it("leaves older widgets without visitor credentials disconnected", async () => {
  credentialSupported = false;
  const assistant = connect("no-credentials");
  script("no-credentials").dispatchEvent(new Event("load"));
  expect(await assistant.send("What should I focus on?")).toBe(
    "The assistant is unavailable.",
  );
  expect(await assistant.open()).toBe("The assistant is unavailable.");
  expect(assistant.requestToken).not.toHaveBeenCalled();
  expect(document.querySelector("solv-chat")).toBeNull();
});
