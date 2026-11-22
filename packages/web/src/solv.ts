import { RadarBandSchema, type RadarBand } from "@heedwork/core";

export interface SolvConfig {
  widgetUrl: string;
  assistantKey: string;
}

interface AssistantToken {
  access_token: string;
  expires_in: number;
  workspace_id: string;
  user_id: string;
}

interface SolvElement extends HTMLElement {
  setToolCredential?(serverUrl: string, token: string | null): void;
  send?(text: string): Promise<{ text: string }>;
  open?(options: { mode: "side"; focus: true }): void | Promise<void>;
}

type Action = {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, { type: "string"; enum?: readonly string[] }>;
    required?: string[];
  };
  confirm: false;
  run: (input: Record<string, unknown>) => { ok: boolean };
};

interface PageActions {
  register(action: Action): void;
  unregister?(name: string): void;
}

export interface SolvView {
  selectItem(id: string): boolean;
  zoomBand(band: RadarBand): boolean;
  switchLens(id: string): boolean;
  openGuidance(): boolean;
}

const tag = "solv-chat";
const unavailable = "The assistant is unavailable.";
const renewBefore = 60_000;
const scripts = new Map<string, Promise<void>>();

function loadWidget(url: string): Promise<void> {
  const cached = scripts.get(url);
  if (cached) return cached;

  const script = document.createElement("script");
  script.src = url;
  script.async = true;
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(fail, 10_000);
    function fail() {
      clearTimeout(timer);
      script.remove();
      scripts.delete(url);
      reject(new Error(unavailable));
    }
    script.addEventListener("error", fail, { once: true });
    script.addEventListener(
      "load",
      () => {
        void customElements.whenDefined(tag).then(() => {
          clearTimeout(timer);
          resolve();
        });
      },
      { once: true },
    );
    document.head.append(script);
  });
  scripts.set(url, loaded);
  return loaded;
}

function registerActions(
  actions: PageActions,
  view: SolvView,
  isActive: () => boolean,
) {
  function register(
    name: string,
    description: string,
    run: Action["run"],
    field?: string,
    values?: readonly string[],
  ) {
    actions.register({
      name,
      description,
      input: {
        type: "object",
        properties: field
          ? { [field]: { type: "string", ...(values && { enum: values }) } }
          : {},
        ...(field && { required: [field] }),
      },
      confirm: false,
      run: (input) => (isActive() ? run(input) : { ok: false }),
    });
    return name;
  }
  const names = [
    register(
      "select_item",
      "Select a Heed item by its ID.",
      ({ item_id }) => ({
        ok: typeof item_id === "string" && view.selectItem(item_id),
      }),
      "item_id",
    ),
    register(
      "zoom_band",
      "Zoom the Heed radar into a time band.",
      ({ band }) => {
        const value = RadarBandSchema.safeParse(band);
        return { ok: value.success && view.zoomBand(value.data) };
      },
      "band",
      RadarBandSchema.options,
    ),
    register(
      "switch_lens",
      "Switch to a Heed lens by its ID.",
      ({ lens }) => ({ ok: typeof lens === "string" && view.switchLens(lens) }),
      "lens",
    ),
    register("open_guidance_editor", "Open the Heed guidance editor.", () => ({
      ok: view.openGuidance(),
    })),
  ];
  return () => names.forEach((name) => actions.unregister?.(name));
}

function scopeConversation(
  assistantKey: string,
  workspaceId: string,
  userId: string,
) {
  // The widget restores its transcript by assistant key. Fence that transcript
  // before connecting an element with a different workspace or user credential.
  const scopeKey = `heed-solv-scope:${assistantKey}`;
  const scope = JSON.stringify([workspaceId, userId]);
  try {
    if (sessionStorage.getItem(scopeKey) !== scope) {
      sessionStorage.removeItem(`solv-chat-open:${assistantKey}`);
      sessionStorage.setItem(scopeKey, scope);
    }
  } catch {
    // The widget can still run without browser storage.
  }
}

export function connectSolv(
  config: SolvConfig,
  {
    workspaceId,
    userId,
    requestToken,
    view,
    signal,
    focusLine,
  }: {
    workspaceId: string;
    userId: string;
    requestToken: (signal: AbortSignal) => Promise<AssistantToken>;
    view: SolvView;
    signal: AbortSignal;
    focusLine: () => void;
  },
) {
  const server = new URL("/mcp", window.location.href).href;
  let element: SolvElement | undefined;
  let unregister: (() => void) | undefined;
  let expiresAt = 0;
  let timer: number | undefined;
  let renewal: Promise<void> | undefined;

  function disconnectWidget() {
    if (!element?.isConnected) return;
    element.setToolCredential?.(server, null);
    element.remove();
    unregister?.();
    unregister = undefined;
  }

  function renew(): Promise<void> {
    if (renewal) return renewal;
    if (!element || signal.aborted) return Promise.resolve();
    const widget = element;
    clearTimeout(timer);
    const requestedAt = Date.now();
    renewal = requestToken(signal)
      .then(({ access_token, expires_in, workspace_id, user_id }) => {
        signal.throwIfAborted();
        const expiry = requestedAt + expires_in * 1000;
        if (workspace_id !== workspaceId || user_id !== userId) {
          expiresAt = 0;
          throw new Error(unavailable);
        }
        if (!access_token || !Number.isFinite(expiry) || expiry <= Date.now())
          throw new Error(unavailable);

        widget.setToolCredential!(server, access_token);
        if (!widget.isConnected) {
          scopeConversation(config.assistantKey, workspaceId, userId);
          const actions = (
            window as Window & { solv?: { actions?: PageActions } }
          ).solv?.actions;
          if (actions)
            unregister = registerActions(
              actions,
              view,
              () => !signal.aborted && widget.isConnected,
            );
          document.body.append(widget);
          // The current widget uses an open shadow root for its launcher.
          if (widget.shadowRoot) {
            const style = document.createElement("style");
            style.textContent = ".solv-launcher { display: none !important; }";
            widget.shadowRoot.append(style);
          }
        }
        expiresAt = expiry;
        timer = window.setTimeout(
          () => void renew(),
          Math.max(0, expiresAt - Date.now() - renewBefore),
        );
      })
      .catch(() => {
        if (signal.aborted) return;
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) disconnectWidget();
        else
          timer = window.setTimeout(
            () => void renew(),
            Math.min(30_000, remaining),
          );
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  }

  async function prepare() {
    try {
      const script = new URL(config.widgetUrl);
      if (script.protocol !== "https:" || script.username || script.password)
        return;
      await loadWidget(script.href);
      signal.throwIfAborted();
      const widget = document.createElement(tag) as SolvElement;
      if (typeof widget.setToolCredential !== "function") return;
      widget.setAttribute("assistant", config.assistantKey);
      widget.setAttribute("endpoint", script.origin);
      widget.setAttribute("hide-launcher", "");
      widget.addEventListener("solv-chat:close", focusLine);
      element = widget;
      await renew();
    } catch {
      // Script failures and incompatible widgets leave the line available.
    }
  }

  const ready = prepare();
  async function activeWidget() {
    await ready;
    if (signal.aborted || !element) return;
    if (expiresAt <= Date.now()) await renew();
    if (!signal.aborted && expiresAt > Date.now() && element?.isConnected)
      return element;
  }

  async function open(widget: SolvElement | undefined) {
    if (typeof widget?.open !== "function") return unavailable;
    await widget.open({ mode: "side", focus: true });
    return "";
  }

  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      disconnectWidget();
    },
    { once: true },
  );

  return {
    open: async () => open(await activeWidget()),
    async send(text: string) {
      const widget = await activeWidget();
      if (typeof widget?.send !== "function") return open(widget);
      return (await widget.send(text)).text;
    },
  };
}
