# Releasing KenNook

**Everyday flow — one command does everything:**

```bash
pnpm commit "what you changed"            # patch release (default)
pnpm commit "added a thing" --minor       # minor release
pnpm commit "broke a thing" --major       # major release
pnpm commit "wip" --dry-run               # preview, change nothing
pnpm commit "small fix" --no-deploy       # release but don't deploy now
```

`pnpm commit` stages everything, bumps the version, rolls the changelog
(your `[Unreleased]` entries if present, else the message becomes the note),
makes one commit, tags, pushes, cuts the GitHub Release, and triggers the
cloud deploy that republishes `kennook.com/version.json`. It's safe to run
constantly: a **pre-flight** (on `main`, origin reachable, not behind) runs
*before* any change, so it can't leave a half-cut release.

Use `pnpm release <patch|minor|major>` instead when the work is **already
committed** and you just want to cut the release.

> The cloud deploy (`cdk deploy`) is heavyweight — it redeploys the whole
> marketing site to publish one JSON file. For rapid iteration use
> `--no-deploy` and deploy periodically.

## Versioning policy

`package.json` `version` is the **single source of truth**. It's baked into
`KENNOOK_VERSION` at build time and published to `kennook.com/version.json`,
which self-hosted instances poll to show the in-app upgrade banner.

We follow [SemVer](https://semver.org). While pre-1.0:

| Bump      | When                                                            |
| --------- | -------------------------------------------------------------- |
| **patch** | Bug fixes only. No new features, no migrations.               |
| **minor** | New features, or any release that **migrates the DB / needs a rebuild** (breaking changes are allowed pre-1.0). |
| **major** | Reserved for 1.0.0 (first stable/public release) and beyond.  |

> The internal DB schema versions (`LATEST_USER_SCHEMA_VERSION`,
> `LATEST_SCHEMA_VERSION`) are an implementation detail and are **not** the
> product version. But any release that bumps one MUST add an **Upgrade notes**
> entry to the changelog (operators need to rebuild).

## Keeping the changelog

`CHANGELOG.md` is the human-curated source of release notes — written for
*users*, not from commit messages. As you land user-facing work, add a bullet
under `## [Unreleased]` in the right category:

- **Added / Changed / Fixed / Removed** — the usual.
- **Upgrade notes** — anything the operator must do (rebuild, migration, new
  config, changed defaults). This is what saves people the "why is it broken
  after I updated" support thread.

## Cutting a release

```bash
pnpm release minor     # or patch / major
```

That command:

1. Refuses to run on a dirty tree or off `main`.
2. Bumps `package.json` `version`.
3. Rolls `[Unreleased]` into a dated `[x.y.z]` section (opens a fresh empty one).
4. Commits, creates annotated tag `vx.y.z`, pushes commit + tag.
5. Creates a GitHub Release with the changelog section as the body
   (needs the `gh` CLI; otherwise it prints the manual command).

## Publishing the manifest (cross-repo)

`version.json` is generated and served from the **marketing/cloud repo**
(`kennook-cloud`, via `marketing/scripts/gen-version.mjs` →
`kennook.com/version.json`). After a release, its deploy must pick up the new
`version` **and** `notes`/`url` so the in-app banner shows "what's new".

Keep the two in sync: the cloud build reads this repo's `package.json` version
and the latest `CHANGELOG.md` section for `notes`, and points `url` at the
GitHub Release. If you change the release flow here, update `gen-version.mjs`
there too.
