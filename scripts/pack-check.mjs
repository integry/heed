import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { log } from "node:console";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const expectedFiles = {
  "@heedwork/core": ["dist/index.js", "dist/index.d.ts"],
  "@heedwork/web": [
    "library/dist/index.js",
    "library/dist/index.d.ts",
    "library/dist/styles.css",
    "src/tokens.css",
    "dist/index.html",
    "dist/service-worker.js",
  ],
  "@heedwork/engine": ["dist/index.js", "dist/index.d.ts"],
};
const excluded =
  /(?:^|\/)(?:\.dev\.vars[^/]*|\.env[^/]*|\.npmrc|[^/]*\.(?:map|pem|key))$|(?:^|[./_-])(?:tests?|specs?|fixtures?)(?=$|[./_-])/i;

const worker = `import {
  basicLimits,
  createApp,
  envKeys,
  googleAllowlistAuth,
  noUsage,
  openAuthOptions,
  type AppEnv,
  type AuthEnv,
  type BasicLimitsEnv,
  type EnvKeysEnv,
} from "@heedwork/engine";

export { Workspace } from "@heedwork/engine";

export default createApp<AppEnv & AuthEnv & BasicLimitsEnv & EnvKeysEnv>(
  (env, context) => ({
    auth: googleAllowlistAuth(env),
    limits: basicLimits(env, context),
    usage: noUsage,
    keys: envKeys(env),
  }),
  openAuthOptions,
);
`;

const scratch = mkdtempSync(join(tmpdir(), "heed-pack-"));
try {
  const destination = process.argv[2] ? resolve(process.argv[2]) : scratch;
  mkdirSync(destination, { recursive: true });
  const packages = JSON.parse(
    execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        destination,
        "./packages/core",
        "./packages/web",
        "./packages/engine",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.deepEqual(
    packages.map(({ name }) => name).sort(),
    Object.keys(expectedFiles).sort(),
  );
  for (const { name, files } of packages) {
    const paths = new Set(files.map(({ path }) => path));
    for (const path of expectedFiles[name]) {
      assert(paths.has(path), `${name} is missing ${path}. Run npm run build.`);
    }
    for (const path of paths) {
      assert(!excluded.test(path), `${name} contains excluded file ${path}`);
    }
    if (name === "@heedwork/web") {
      for (const extension of [".js", ".css"]) {
        assert(
          [...paths].some(
            (path) =>
              path.startsWith("dist/assets/") && path.endsWith(extension),
          ),
          `${name} is missing prebuilt ${extension} assets.`,
        );
      }
    }
  }

  const host = join(scratch, "host");
  mkdirSync(host);
  const writeJson = (path, value) =>
    writeFileSync(join(host, path), JSON.stringify(value));
  writeJson("package.json", { private: true, type: "module" });
  writeFileSync(join(host, "worker.ts"), worker);
  writeJson("wrangler.json", {
    name: "heed-package-smoke",
    main: "worker.ts",
    compatibility_date: "2026-08-15",
    assets: { directory: "node_modules/@heedwork/web/dist" },
    durable_objects: {
      bindings: [{ name: "WORKSPACE", class_name: "Workspace" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Workspace"] }],
  });
  writeJson("tsconfig.json", {
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      types: [],
    },
    files: ["worker.ts", "worker-configuration.d.ts"],
  });

  const run = (script, ...args) =>
    execFileSync(process.execPath, [script, ...args], {
      cwd: host,
      stdio: "inherit",
    });
  run(
    process.env.npm_execpath,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...packages.map(({ filename }) => join(destination, filename)),
  );
  for (const { name, files } of packages) {
    for (const { path } of files) {
      if (!/\.(?:[cm]?js|css|ts)$/.test(path)) continue;
      const contents = readFileSync(
        join(host, "node_modules", name, path),
        "utf8",
      );
      assert(
        !/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=\s*data:/i.test(contents),
        `${name} contains an inline source map in ${path}`,
      );
    }
  }
  const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
  run(wrangler, "types");
  run(join(root, "node_modules/typescript/bin/tsc"));
  run(wrangler, "deploy", "--dry-run", "--outdir", "bundle");
  log("Verified all three tarballs and bundled the consumer Worker.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
