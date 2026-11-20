import type { SocketMessage, SocketRequest } from "../shared/workspace-socket";
import {
  initialWorkspaceState,
  queueMutation,
  receiveMessage,
  type MutationInput,
  type WorkspaceState,
} from "./workspace-state";

export function createWorkspaceConnection() {
  let state = initialWorkspaceState();
  let activeSocket: WebSocket | undefined;
  const listeners = new Set<() => void>();

  function publish(next: WorkspaceState) {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function mutate(mutation: MutationInput) {
    const socket = activeSocket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      state.connection !== "live"
    )
      return false;
    const requestId = crypto.randomUUID();
    try {
      socket.send(
        JSON.stringify({ ...mutation, requestId } satisfies SocketRequest),
      );
      publish(queueMutation(state, requestId, mutation));
      return true;
    } catch {
      socket.close();
      return false;
    }
  }

  function start(onSessionExpired: () => void) {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;

    async function retryConnection() {
      // A failed WebSocket upgrade does not expose the HTTP status to browsers.
      try {
        const response = await fetch("/api/me", { signal: controller.signal });
        if (response.status === 401 && !controller.signal.aborted) {
          onSessionExpired();
          return;
        }
      } catch {
        // The next socket attempt can recover after a temporary network failure.
      }
      if (!controller.signal.aborted) connect();
    }

    function disconnected() {
      if (controller.signal.aborted) return;
      clearTimeout(watchdog);
      activeSocket = undefined;
      publish({
        ...state,
        seq: 0,
        connection: "reconnecting",
        pending: new Map(),
        error: state.pending.size
          ? "Connection lost while changes were saving. Check the workspace after reconnecting."
          : state.error,
      });
      retry = setTimeout(() => void retryConnection(), delay);
      delay = Math.min(delay * 2, 30_000);
    }

    function connect() {
      const url = new URL("/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        disconnected();
        return;
      }
      activeSocket = socket;
      const awaitSnapshot = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => socket.close(), 10_000);
      };
      awaitSnapshot();

      socket.addEventListener("message", ({ data }) => {
        if (activeSocket !== socket) return;
        let message: SocketMessage;
        try {
          message = JSON.parse(data) as SocketMessage;
          if (!Number.isSafeInteger(message?.seq) || message.seq < 1)
            throw new Error("Invalid sequence");
        } catch {
          socket.close();
          return;
        }

        const previous = state;
        publish(receiveMessage(state, message));
        if (state === previous) return;
        if (message.type === "SNAPSHOT") {
          clearTimeout(watchdog);
          delay = 1000;
          const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (message.timezoneConfigured === false && timezone) {
            mutate({ type: "INITIALIZE_TIMEZONE", input: { timezone } });
          }
        } else if (
          state.connection === "syncing" &&
          previous.connection !== "syncing"
        ) {
          awaitSnapshot();
          try {
            socket.send(
              JSON.stringify({ type: "GET_SNAPSHOT" } satisfies SocketRequest),
            );
          } catch {
            socket.close();
          }
        }
      });
      socket.addEventListener("close", () => {
        if (activeSocket === socket) disconnected();
      });
    }

    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(watchdog);
      const socket = activeSocket;
      activeSocket = undefined;
      socket?.close();
      state = initialWorkspaceState();
    };
  }

  return {
    start,
    mutate,
    getSnapshot: () => state,
    clearError: () => publish({ ...state, error: null }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
