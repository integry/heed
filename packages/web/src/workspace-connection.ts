import type { SocketMessage, SocketRequest } from "@heedwork/core";
import {
  initialWorkspaceState,
  queueMutation,
  receiveMessage,
  type MutationInput,
  type WorkspaceState,
} from "./workspace-state";

export function createWorkspaceConnection(notificationItemId: string | null) {
  let state = { ...initialWorkspaceState(), notificationItemVersion: 0 };
  let activeSocket: WebSocket | undefined;
  const listeners = new Set<() => void>();
  type Ack = Extract<SocketMessage, { type: "ACK" }>;
  const replies = new Map<
    string,
    {
      resolve: (ack: Ack) => void;
      reject: (error: Error) => void;
      callerReportsError?: boolean;
    }
  >();

  function rejectReplies(message: string) {
    for (const reply of replies.values()) reply.reject(new Error(message));
    replies.clear();
  }

  function publish(next: WorkspaceState, invalidateNotificationItem = false) {
    if (state === next) return;
    state = {
      ...next,
      notificationItemVersion:
        state.notificationItemVersion + Number(invalidateNotificationItem),
    };
    for (const listener of listeners) listener();
  }

  function send(mutation: MutationInput, requestId: string) {
    const socket = activeSocket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      state.connection !== "live"
    )
      return false;
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

  function mutate(mutation: MutationInput) {
    return send(mutation, crypto.randomUUID());
  }

  function save(
    mutation: MutationInput,
    options?: { callerReportsError: boolean },
  ): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      replies.set(requestId, { resolve, reject, ...options });
      if (!send(mutation, requestId)) {
        replies.delete(requestId);
        reject(
          new Error("Changes can be saved when the workspace reconnects."),
        );
      }
    });
  }

  function start(onSessionExpired: (devLoginEnabled?: boolean) => void) {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;

    async function retryConnection() {
      // A failed WebSocket upgrade does not expose the HTTP status to browsers.
      try {
        const response = await fetch("/api/me", { signal: controller.signal });
        if (response.status === 401 && !controller.signal.aborted) {
          const data = await response.json().catch(() => null);
          if (!controller.signal.aborted)
            onSessionExpired(data?.devLoginEnabled === true);
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
      const needsErrorBanner = [...state.pending.keys()].some(
        (id) => !replies.get(id)?.callerReportsError,
      );
      rejectReplies(
        "Connection lost while saving. Check the workspace after reconnecting.",
      );
      publish({
        ...state,
        seq: 0,
        connection: "reconnecting",
        pending: new Map(),
        error: needsErrorBanner
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
        const next = receiveMessage(state, message);
        // A replacement snapshot can omit an item whose removal we missed.
        const invalidateNotificationItem =
          notificationItemId !== null &&
          next !== previous &&
          next.connection === "live" &&
          (message.type === "SNAPSHOT" ||
            message.type === "CANVAS_REPLACE" ||
            (message.type === "ITEM_UPSERT" &&
              message.item.id === notificationItemId) ||
            (message.type === "ITEM_REMOVE" &&
              message.item_id === notificationItemId));
        const callerReportsError =
          message.type === "ERROR" &&
          message.requestId &&
          replies.get(message.requestId)?.callerReportsError;
        publish(
          callerReportsError && next !== previous
            ? { ...next, error: previous.error }
            : next,
          invalidateNotificationItem,
        );
        if (state === previous) return;
        if (
          (message.type === "ACK" || message.type === "ERROR") &&
          message.requestId
        ) {
          const reply = replies.get(message.requestId);
          replies.delete(message.requestId);
          if (message.type === "ACK") reply?.resolve(message);
          else
            reply?.reject(
              new Error(message.error.reason ?? message.error.message),
            );
        }
        if (message.type === "SNAPSHOT") {
          rejectReplies(
            "The workspace resynchronized while saving. Check whether your change was saved.",
          );
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
      rejectReplies("The workspace connection closed.");
      state = {
        ...initialWorkspaceState(),
        notificationItemVersion: state.notificationItemVersion + 1,
      };
    };
  }

  return {
    start,
    mutate,
    save,
    getSnapshot: () => state,
    clearError: () => publish({ ...state, error: null }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
