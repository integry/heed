import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PwaUpdate } from "./PwaUpdate";
import type { MountAppOptions, MountedApp } from "./web-options.js";

export { ApiError, getJson, postJson, useResource } from "./api.js";
export type { ApiHelpers, Resource } from "./api.js";
export type {
  AppUser,
  BuiltInScreenId,
  HeaderSlotProps,
  MountAppOptions,
  MountedApp,
  SettingsScreen,
  SettingsScreenProps,
  SignInProps,
} from "./web-options.js";

export function mountApp(root: Element, options?: MountAppOptions): MountedApp {
  const app = createRoot(root);
  let revision = 0;
  let scope = new AbortController();
  let mounted = true;

  function render() {
    app.render(
      <>
        <App
          key={revision}
          options={options}
          scopeSignal={scope.signal}
          onWorkspaceChange={onWorkspaceChange}
        />
        {import.meta.env.HEED_PREBUILT && <PwaUpdate />}
      </>,
    );
  }

  function onWorkspaceChange() {
    if (!mounted) return;
    scope.abort();
    scope = new AbortController();
    revision++;
    render();
  }

  render();
  return {
    onWorkspaceChange,
    unmount() {
      if (!mounted) return;
      mounted = false;
      scope.abort();
      app.unmount();
    },
  };
}
