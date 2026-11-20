import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const publicShell = [
  "/manifest.webmanifest",
  "/icons/heed-180.png",
  "/icons/heed-192.png",
  "/icons/heed-512.png",
];

export default defineConfig({
  root: "src/web",
  plugins: [
    {
      name: "heed-app-shell",
      apply: "build",
      generateBundle: {
        order: "post",
        handler(_, bundle) {
          const worker = readFileSync(
            new URL("./src/web/service-worker.js", import.meta.url),
            "utf8",
          );
          const hash = createHash("sha256").update(worker);
          const paths = [...publicShell];
          for (const path of publicShell) {
            hash.update(
              readFileSync(new URL(`./src/web/public${path}`, import.meta.url)),
            );
          }
          for (const name of Object.keys(bundle).sort()) {
            const entry = bundle[name]!;
            paths.push(`/${name}`);
            hash
              .update(name)
              .update(entry.type === "chunk" ? entry.code : entry.source);
          }
          if (!paths.includes("/index.html"))
            this.error("The Heed app shell is missing index.html.");
          const shell = { version: hash.digest("hex").slice(0, 24), paths };
          this.emitFile({
            type: "asset",
            fileName: "service-worker.js",
            source: worker.replace(
              /\/\* APP_SHELL \*\/ \{ version: "", paths: \[\] \}/,
              JSON.stringify(shell),
            ),
          });
        },
      },
    },
  ],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
