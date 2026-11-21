# Extending the Heed web app

Use the prebuilt `dist/` app if you want the standard self-hosted screens. To add your own sign-in or workspace controls, bundle the ESM entry of `@heedwork/web` with your app. Install React and React DOM in the host alongside `@heedwork/web`. Import `@heedwork/web/styles.css` for the app styles.

Serve the host app **from the same origin as the Heed API**. The app uses the browser session for relative requests to `/api/*` and opens its WebSocket at `/ws`. In production, use HTTPS. Serve your own authentication routes and static assets with the host. The prebuilt app registers its own service worker. The Notifications screen in a custom host uses the host’s service worker registration.

## Example

In a React TypeScript entry point with a `<div id="root"></div>`, mount the app with your host components. This example uses host endpoints for sign-in, sign-out, the active workspace, and plan information.

```tsx
import { mountApp, type SignInProps } from "@heedwork/web";
import "@heedwork/web/styles.css";

function SignIn({ returnTo }: SignInProps) {
  return (
    <main className="sign-in">
      <a
        className="primary"
        href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
      >
        Sign in to Example Workspaces
      </a>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");

const app = mountApp(root, {
  signIn: SignIn,
  async onSignOut() {
    const response = await fetch("/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Couldn’t sign out. Try again.");
  },
  headerStart: ({ workspaceId }) => <span>{workspaceId}</span>,
  headerEnd: ({ user }) => <span>{user.name ?? user.email}</span>,
  hideScreens: ["tokens"],
  extraSettingsScreens: [
    {
      id: "plan",
      label: "Workspace plan",
      component: function Plan({ role, api }) {
        const { data, error, loading, reload } = api.useResource<{
          name: string;
        }>("/api/host/plan");
        if (loading) return <p role="status">Loading plan…</p>;
        if (error)
          return (
            <>
              <p role="alert">{error.message}</p>
              <button onClick={reload}>Retry</button>
            </>
          );
        return (
          <p>
            {data?.name} · {role}
          </p>
        );
      },
    },
  ],
});

// Call this after your server has changed the active workspace.
export async function switchWorkspace(workspaceId: string) {
  const response = await fetch("/api/host/active-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) throw new Error("Couldn’t switch workspaces.");
  app.onWorkspaceChange();
}
```

- **Authentication.** The sign-in component receives `returnTo`, the current path, query, and fragment. Your sign-in route should validate it as a local redirect target. The returned app handle exposes `unmount()` for hosts that remove the app.
- **Workspace context.** Have `GET /api/me` return `workspaceId`, `user: { id, email, name }`, `role`, and `capabilities: { command, transcription }`. Set `managed: true` to suppress model-key setup hints. Set `managed: false` to show setup instructions when commands are unavailable. Header slots and extra Settings components receive `user`, `workspaceId`, `role`, and `api`. Header slots also receive `onWorkspaceChange()`, which reloads the session, clears workspace state, and opens a new WebSocket.
- **Settings.** Give each extra screen a unique `id` and a `label` for its section heading. The built-in IDs for `hideScreens` are `notifications`, `projects`, `tokens`, `account`, and `model-keys`.
- **API helpers.** Use `api.getJson<T>(path, signal?)` and `api.postJson<T>(path, body, signal?)` inside host screens and slots so a 401 switches the mounted app to sign-in. Both throw `ApiError` for HTTP failures, with `status`, an optional `code`, and the server's error message. The package also exports standalone `getJson` and `postJson`, and `useResource<T>(path)` for React components. The hook returns `{ data, error, loading, reload }` and accepts `null` to skip loading.
- **Design tokens.** `@heedwork/web/styles.css` includes the light and dark token values. Import `@heedwork/web/tokens.css` on host pages that need just the tokens, such as `--surface`, `--text`, `--accent`, and `--radius`.
