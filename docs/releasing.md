# Releasing the npm packages

Each release publishes `@heedwork/core`, `@heedwork/web`, and `@heedwork/engine` at the same version. Consumers can pin all three to that exact version.

## One-time npm setup

1. Create the `@heedwork` organization on npm and give the publishing account permission to create and publish packages in that scope.
2. Create a granular npm access token for automation. Give it read and write access to publish in the `@heedwork` scope, with **Bypass 2FA** enabled for non-interactive publishing. [npm access token documentation](https://docs.npmjs.com/about-access-tokens/)
3. Store the token as the `NPM_TOKEN` GitHub Actions repository secret. Replace the secret when you rotate the token. The GitHub-hosted release job uses `id-token: write` to generate npm provenance.

## Cut a release

Choose an unused `v<semver>` tag on a commit already on `origin/main`. Use a stable version such as `v1.2.3` or a prerelease such as `v1.2.3-rc.1`. Omit `+build` metadata because npm strips it when publishing. The workflow publishes prereleases under the npm `next` dist-tag.

```sh
git fetch origin main
git tag -a v1.2.3 origin/main -m "Release v1.2.3"
git push origin refs/tags/v1.2.3
```

A tag push starts the release. The workflow validates the tag and checks that its commit is reachable from `origin/main`, then runs `npm ci` and `npm run check`. It stamps the three package manifests and their internal `@heedwork/*` dependencies with the exact tag version in the runner checkout. It then checks the release tarballs and publishes those same files publicly with provenance, starting with core, then web, then engine.

## Dry runs and retries

To verify an existing tag, manually dispatch **Release npm packages** against it. `dry_run` defaults to `true`. A dry run validates the tag, runs the checks, and packs and installs the stamped tarballs without npm credentials or a publish step.

```sh
gh workflow run release.yml --ref v1.2.3 -f dry_run=true
```

For local verification, run `npm ci` and `npm run check`. The check includes `npm run pack-check`, which inspects the tarballs, installs them into a temporary project outside the workspace, typechecks a host Worker, and runs `wrangler deploy --dry-run`. To run just the packing and consumer checks, run `npm run build` followed by `npm run pack-check`.

If publishing fails partway through, rerun the failed GitHub Actions job or dispatch the same tag with `dry_run=false`. The workflow checks npm for each exact package version and skips versions already present. Published versions are immutable. Never modify or unpublish them. Cut a new version for corrections.
