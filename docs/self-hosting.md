# Self-host Heed on Cloudflare

A self-hosted Heed deployment serves one shared workspace. Everyone you allow to sign in can work in that workspace and manage its API tokens.

## Prerequisites

- A Cloudflare account with Workers enabled. SQLite Durable Objects are available on the [Workers Free plan](cost.md).
- A GitHub account for the Deploy to Cloudflare flow and a Google Cloud project where you can create an OAuth client.
- Node.js 22.22.2 or a newer release in the Node 22 series, npm, and OpenSSL for the local commands. Run them from the root of your Heed source copy.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fintegry%2Fheed%2Ftree%2F51-epic-heed-open-dcm)

1. Sign in to Cloudflare and authorise GitHub when prompted. Choose a Worker name and a repository for your copy.
2. Use the repository root as the build root directory, `npm run build` as the build command, and `npx wrangler deploy --keep-vars` as the deploy command. The build compiles the core package, prepares the static assets in `packages/web/dist`, and checks the engine bundle. The root Wrangler configuration deploys the engine and web assets and provisions the SQLite Durable Object. You can update these commands under your Worker's **Settings → Build**.
3. Copy the new Worker's HTTPS origin, such as `https://heed.your-subdomain.workers.dev`, for the Google OAuth setup. You can add runtime variables and secrets after the initial deployment.

### Deploy from the command line

You can also deploy from a copy of the [Heed source](https://github.com/integry/heed/tree/51-epic-heed-open-dcm). To choose a different Worker name, edit `name` in the root [wrangler.jsonc](../wrangler.jsonc) before the first deploy.

```sh
npm ci
npx wrangler login
npm run build
npx wrangler deploy --keep-vars
```

Use the HTTPS origin printed by Wrangler for the next step.

## Create the Google OAuth client

1. In your Google Cloud project, open **Google Auth Platform** and complete the consent screen setup. Choose an audience that includes your intended sign-in accounts. If you're using an External app in Testing, add those accounts as test users.
2. Under **Clients**, create a client of type **Web application**. In **Authorized redirect URIs**, add your exact Heed HTTPS origin followed by `/auth/callback`, for example `https://heed.your-subdomain.workers.dev/auth/callback`. Register each origin you use to sign in, including a custom domain if applicable. For Google sign-in during local development, add `http://localhost:8787/auth/callback`.
3. Save the client ID and client secret for the Worker configuration. [Google OAuth client setup](https://support.google.com/cloud/answer/15549257?hl=en)

## Configure variables and secrets

In Cloudflare, go to **Workers & Pages → your Worker → Settings → Variables and Secrets**. Add the values as runtime settings and deploy the changes. Use the **Secret** type for encrypted values. For local development, use [`.dev.vars.example`](../.dev.vars.example) as the template for `.dev.vars`. Keep `DEV_LOGIN_EMAIL` in local development only.

Generate a new session secret for this deployment:

```sh
openssl rand -hex 32
```

| Name                   | Cloudflare type | Value                                                                                      |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`     | Text            | Client ID from Google Auth Platform.                                                       |
| `GOOGLE_CLIENT_SECRET` | Secret          | Client secret from Google Auth Platform.                                                   |
| `SESSION_SECRET`       | Secret          | Random value from the command above. Changing it signs out existing users.                 |
| `ALLOWED_EMAILS`       | Text            | Comma-separated Google account email addresses. An empty allowlist denies Google sign-ins. |

### Web Push

For handoff notifications, run the following from the Heed source directory:

```sh
npm run vapid:generate
```

Store the generated `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` and a `VAPID_SUBJECT` as Worker secrets. Set the subject to a contact URL or an address such as `mailto:admin@example.com`. Keep the key pair across upgrades so existing browser subscriptions can continue working.

On each device, open **Settings → Notifications** and select **Enable notifications**. On iOS, add Heed to the Home Screen and open it from there first. **Send test notification** checks that the device can display a local notification. Each agent handoff with `notify: true` counts once toward the sending token's rolling hourly limit and is sent to all subscribed devices. Set `PUSH_RATE_LIMIT_PER_HOUR` to override the default of six. A value of zero disables agent push.

### Optional voice and chat

- **Workers AI.** Uncomment the `ai` binding in [wrangler.jsonc](../wrangler.jsonc), then redeploy and set `WORKERS_AI_COMMAND_MODEL` to a model that supports multi-turn tool calling. Local Wrangler also requires Cloudflare sign-in when this binding is enabled.
- **Anthropic.** Set the `ANTHROPIC_API_KEY` secret and the `ANTHROPIC_COMMAND_MODEL` text variable. Anthropic takes precedence when both providers are configured. To use an Anthropic-compatible gateway such as OpenRouter, also set `ANTHROPIC_MESSAGES_URL` (for OpenRouter, `https://openrouter.ai/api/v1/messages`) and use the gateway's key and model name.

The command bar appears when a provider is configured. Heed sends the command, standing guidance, and a compact workspace view to that provider. Voice uses browser speech recognition where available, with Workers AI Whisper as a fallback when the `AI` binding is enabled. See [AI limits and costs](cost.md#optional-ai-usage).

### Optional solv.chat assistant

Set `SOLV_WIDGET_URL` to the full HTTPS URL of the widget script and `SOLV_ASSISTANT_KEY` to the assistant's public embed key. Put both values in the Worker's runtime variables and in the build environment. The build generates Static Assets security headers for the widget origin, so rebuild and redeploy when enabling the assistant or changing its origin. For local Wrangler development, put the values in `.dev.vars` and export the same two variables in the shell before running `npm run dev -- --local-protocol https`. Leave both unset to disable the widget.

Use any [solv.chat engine](https://github.com/integry/solv.chat) that supports visitor tool credentials. You can self-host it with your own model credentials or use a hosted engine. Serve the widget script from the engine's origin and allow your Heed origin in the assistant's embed settings. In the assistant's tool settings, add your exact Heed URL ending in `/mcp` and configure that server to take the visitor's credential. Heed supplies a short-lived credential for the signed-in user's workspace. Enable the widget's side-panel layout for the full conversation, which users can open by typing `open chat`.

Suggested assistant behaviour prompt

> Help the user understand and update their Heed workspace. Use Heed's MCP tools to find items and read current guidance before acting. Change only what the user asks to change. Ask a short clarifying question if the item or requested change is ambiguous. Use page actions to bring the relevant item or view into focus. Keep replies brief and confirm what changed.

### Optional shadow judge

The judge is off by default. Set both text variables and the secret to enable it.

| Name            | Type          | Value                                         |
| --------------- | ------------- | --------------------------------------------- |
| `JUDGE_URL`     | Text variable | The full System One endpoint URL.             |
| `JUDGE_MODEL`   | Text variable | The provider's model ID. There is no default. |
| `JUDGE_API_KEY` | Secret        | The API key for the selected provider.        |

For TypeSafe, use `https://api.typesafe.ai/v1/systemone` with a model ID such as `jev-1.14.0`. For OpenRouter, use `https://openrouter.ai/api/v1/systemone` with a model ID such as `typesafe/jev-1.14`. Pin a versioned model ID so that agreement data is comparable across reports.

When an agent completes an item with acceptance criteria, Heed sends the item title, criteria, supplied evidence, report note, and workspace guidance to the configured endpoint. Signed-in users can review the shadow verdict in the inspector and see agreement with retained verdicts in Settings. See [judge costs](cost.md#optional-ai-usage).

## First sign-in and API token

1. Open the deployed HTTPS origin, select **Sign in with Google**, and choose an account listed in `ALLOWED_EMAILS`. If Google reports `redirect_uri_mismatch`, check that the exact origin and `/auth/callback` path are registered.
2. Open **Settings → API tokens**, enter a label, and select **Report** for an agent. Choose a default project or leave **Use Inbox** selected.
3. Select **Create token** and copy the token while it is visible. Store it securely and use it in the [agent setup guide](agents.md). Use **Revoke** in the same panel if the token is lost or exposed.

### Optional CLI token bootstrap

For headless setup, store a separate random `ADMIN_SECRET` on the Worker and supply the same value as an environment variable in your terminal. Set `HEED_URL` to your deployment's HTTPS origin and run:

```sh
npm run token:create -- "Build agent" report
```

The command prints the token once. It also reads `ADMIN_SECRET` from `.dev.vars` in local development and defaults to `http://localhost:8787`. Remove the deployed `ADMIN_SECRET` when you finish using CLI bootstrap to close the admin endpoint.

## Upgrade an existing deployment

Bring the newer Heed source into the repository connected to Workers Builds, keeping its Worker name and any local configuration such as the `AI` binding. Let the production branch build deploy to the existing Worker. If you deploy manually, run `npm ci`, `npm run build`, and `npx wrangler deploy --keep-vars` from the updated source in the same Cloudflare account.

Keep the existing `WORKSPACE` binding and migration history so the Worker continues to use the same SQLite Durable Object. Wrangler applies any new Durable Object migrations during deploy, and Heed updates the workspace schema when it opens the database. The `--keep-vars` flag preserves dashboard text variables on redeploy. Wrangler preserves Worker secrets. After deploying, sign in and confirm your existing items and agent connection.
