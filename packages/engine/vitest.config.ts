import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      main: "./src/test-host.ts",
      wrangler: {
        configPath: fileURLToPath(
          new URL("../../wrangler.jsonc", import.meta.url),
        ),
      },
      remoteBindings: false,
      miniflare: {
        durableObjects: {
          HOST_WORKSPACE: { className: "HostedWorkspace", useSQLite: true },
        },
        bindings: {
          // Test-only P-256 key pair for signing requests to mocked endpoints.
          VAPID_SUBJECT: "mailto:push@example.test",
          VAPID_PUBLIC_KEY:
            "BPZgAepABXAFmhGrRJbv94iqTN8LjQtAzS5aQKPQ7l9h7G2C4IJvsMM9KbFxLxCnC5mgkAfPzKhC1lJ7R6I27U8",
          VAPID_PRIVATE_KEY: "Vz_5Zt2i1QxMn423Vyn4SMmeyUrmeVxtI51zBbv9Gqw",
        },
      },
    }),
  ],
  test: {
    name: "engine",
    include: ["src/**/*.test.ts"],
  },
});
