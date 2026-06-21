# Changelog

All notable, user-facing changes to KenNook are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, **MINOR** bumps may include breaking changes; **PATCH** is fixes only.

Cut a release with `pnpm release <patch|minor|major>` — see `RELEASING.md`.
Anything under **Upgrade notes** requires action on the operator's part
(a rebuild, a migration, a config change) before/after updating.

## [Unreleased]

## [0.2.1] - 2026-06-21

### Changed
- Documentation: refreshed the README — an accurate current feature list and a
  short directional roadmap, replacing the stale v0.1-era scope and roadmap
  sections.

## [0.2.0] - 2026-06-21

### Added
- Pinterest-style masonry library grid — thumbnails render at their natural
  aspect ratio and fill the page edge-to-edge.
- Collapsible filters sidebar (toggle in the header; remembered per browser).
- Admin **Configuration** section (renamed from "Feature flags") with an
  instance-wide **Screensaver on/off** toggle.
- Zero-config device access: KenNook advertises `kennook.local` over mDNS and a
  "Connect a device" panel shows a scannable QR for other devices on your Wi-Fi.
- Optional **screensaver passphrase lock** and per-account **login passwords**
  with an app-wide login gate.
- Per-asset pan/zoom framing is now saved server-side and shared across devices,
  kept separately per screen orientation.
- Up/Down arrow keys navigate previous/next item (alongside J/K).

### Changed
- Continuous zoom in the viewer: smooth fill ↔ reveal with no jump at 100%, and
  panning stays available when zoomed out.

### Upgrade notes
- This release runs **database migrations** (per-library and user databases).
  Rebuild before starting your production server:
  `pnpm build:prod && pnpm start:prod`.
- **Login is now required** once the default account has a password. A starter
  password (`password`) is seeded for first login — change it immediately in
  **Admin → Users**. The screensaver passphrase also defaults to `password`;
  change or clear it in **Admin → Configuration / Settings**.

## [0.1.1]

- Baseline. Releases before this changelog existed are not itemized here.
