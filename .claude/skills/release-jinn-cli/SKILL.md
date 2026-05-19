---
name: release-jinn-cli
description: Use when cutting a new jinn-cli release for this repo — bumping the version, publishing to npm, creating the GitHub release, and letting the Homebrew formula auto-update. Covers the exact order that matters (npm publish BEFORE publishing the GitHub release).
---

# Releasing jinn-cli

The published npm package is **`jinn-cli`** (lives in `packages/jimmy`). The root
package (`jinn`) is private; `packages/web` is internal (its version isn't shipped).
Version lives in **one place**: `packages/jimmy/package.json`.

## How the pieces connect

- **npm**: published manually with `npm publish` from `packages/jimmy`. The package
  ships `dist/` and `template/` (see its `files`), so you MUST build first.
- **GitHub release**: created for tag `vX.Y.Z`.
- **Homebrew**: `.github/workflows/bump-formula.yml` fires on `release: published`.
  It waits (up to ~5 min) for the npm tarball at
  `registry.npmjs.org/jinn-cli/-/jinn-cli-X.Y.Z.tgz`, computes its sha256, rewrites
  `Formula/jinn.rb`, and pushes the bump to `main`.
- **CI** (`ci.yml`) runs typecheck/test/build on `main` + PRs. It does **not** publish.

> **Order matters:** publish to npm **before** publishing the GitHub release, or the
> formula-bump job will wait and then fail because the tarball isn't on npm yet.

## Steps

1. **Land the work on `main`** (merge the PR). Releases are cut from `main`; the
   formula-bump job also pushes to `main`. Ensure a clean tree: `git status`.

2. **Pick the version.** This is `0.x`, so a minor bump (`0.N.0`) is fine even for
   small breaking changes; patch (`0.x.N`) for fixes only.

3. **Bump + commit** (no `Co-Authored-By: Claude` trailer — repo convention):
   ```bash
   # edit packages/jimmy/package.json "version"
   git commit -am "chore(release): jinn-cli vX.Y.Z"
   ```

4. **Build + verify** from repo root:
   ```bash
   pnpm build      # turbo build + copies packages/web/out -> packages/jimmy/dist/web
   pnpm typecheck && pnpm test
   ```

5. **Publish to npm** (needs `npm whoami` to be the publisher):
   ```bash
   cd packages/jimmy && npm publish && cd -
   ```
   This is the irreversible step — confirm with the maintainer first.

6. **Tag + push:**
   ```bash
   git tag vX.Y.Z && git push origin main --tags
   ```

7. **Create the GitHub release** (publishing it triggers the Homebrew bump):
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "...release notes..."
   ```
   For a dry run, add `--draft` (drafts do NOT trigger the formula workflow).

8. **Verify**: a `formula: bump to vX.Y.Z` commit lands on `main` within ~5 min
   (check the bump-formula workflow run), and `npm view jinn-cli version` is X.Y.Z.

## Notes
- Don't bump `package.json` in the root or `packages/web` — only `packages/jimmy`.
- If the formula job fails, it's almost always the npm tarball not being live yet;
  re-run the workflow once `npm view jinn-cli@X.Y.Z` resolves.
