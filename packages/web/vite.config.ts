import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const publicShell = [
  "/manifest.webmanifest",
  "/icons/heed-180.png",
  "/icons/heed-192.png",
  "/icons/heed-512.png",
];

function staticHeaders() {
  const widget = URL.parse(process.env.SOLV_WIDGET_URL?.trim() ?? "");
  // A URL hostname can contain characters that are special in a CSP.
  const origin =
    process.env.SOLV_ASSISTANT_KEY?.trim() &&
    widget?.protocol === "https:" &&
    !widget.username &&
    !widget.password &&
    /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(widget.hostname)
      ? ` ${widget.origin}`
      : "";
  const policy = [
    "default-src 'self'",
    `script-src 'self'${origin}`,
    `connect-src 'self'${origin}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${origin}`,
    `frame-src${origin || " 'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `/*\n  Content-Security-Policy: ${policy}\n`;
}

export default defineConfig(({ mode }) => {
  if (mode === "library") {
    return {
      publicDir: false,
      build: {
        outDir: fileURLToPath(new URL("./library/dist", import.meta.url)),
        emptyOutDir: true,
        lib: {
          entry: fileURLToPath(new URL("./src/library.ts", import.meta.url)),
          formats: ["es"],
          fileName: "index",
          cssFileName: "styles",
        },
        rolldownOptions: {
          external: [/^(react|react-dom)(\/|$)/, "@heedwork/core", /^d3-/],
        },
      },
    };
  }

  return {
    define: { "import.meta.env.HEED_PREBUILT": "true" },
    root: fileURLToPath(new URL("./src", import.meta.url)),
    plugins: [
      {
        name: "heed-app-shell",
        apply: "build",
        generateBundle: {
          order: "post",
          handler(_, bundle) {
            const worker = readFileSync(
              new URL("./src/service-worker.js", import.meta.url),
              "utf8",
            );
            const hash = createHash("sha256").update(worker);
            const headers = staticHeaders();
            hash.update(headers);
            const paths = [...publicShell];
            for (const path of publicShell) {
              hash.update(
                readFileSync(new URL(`./src/public${path}`, import.meta.url)),
              );
            }
            for (const name of Object.keys(bundle).sort()) {
              const entry = bundle[name]!;
              // Cloudflare serves index.html at the canonical root URL.
              paths.push(name === "index.html" ? "/" : `/${name}`);
              hash
                .update(name)
                .update(entry.type === "chunk" ? entry.code : entry.source);
            }
            if (!paths.includes("/"))
              this.error("The Heed app shell is missing index.html.");
            const shell = { version: hash.digest("hex").slice(0, 24), paths };
            this.emitFile({
              type: "asset",
              fileName: "_headers",
              source: headers,
            });
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
      outDir: "../dist",
      emptyOutDir: true,
    },
  };
});
