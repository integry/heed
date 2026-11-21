import { execFileSync } from "node:child_process";
import { log } from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const packages = ["core", "web", "engine"];
const registry = "https://registry.npmjs.org/";
const [command, ref, destination] = process.argv.slice(2);
const number = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
// npm strips build metadata when publishing, so it cannot preserve that version.
const releaseRef = new RegExp(
  `^refs/tags/v(${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?)$`,
);
const version = releaseRef.exec(ref)?.[1];
if (!version) {
  throw new Error("Select a v<semver> tag with no +build metadata.");
}

switch (command) {
  case "validate":
    break;
  case "stamp":
    for (const name of packages) {
      const path = join("packages", name, "package.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.version = version;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (dependency.startsWith("@heedwork/")) {
            manifest[field][dependency] = version;
          }
        }
      }
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    break;
  case "publish":
    for (const name of packages) {
      const packageName = `@heedwork/${name}`;
      const spec = `${packageName}@${version}`;
      const url = `${registry}${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
      const response = await globalThis.fetch(url, {
        cache: "no-store",
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (response.ok) {
        log(`Skipping ${spec}. It is already on npm.`);
        continue;
      }
      if (response.status !== 404) {
        throw new Error(
          `Could not check ${spec} on npm (HTTP ${response.status}).`,
        );
      }
      if (!process.env.NODE_AUTH_TOKEN)
        throw new Error("Set the NPM_TOKEN repository secret.");
      execFileSync(
        "npm",
        [
          "publish",
          join(destination, `heedwork-${name}-${version}.tgz`),
          "--registry",
          registry,
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
          ...(version.includes("-") ? ["--tag", "next"] : []),
        ],
        { stdio: "inherit" },
      );
    }
    break;
  default:
    throw new Error(`Unknown release command ${command}.`);
}
