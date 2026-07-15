# Changelog

All notable, user-facing changes to KenNook are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, **MINOR** bumps may include breaking changes; **PATCH** is fixes only.

Cut a release with `pnpm release <patch|minor|major>` — see `RELEASING.md`.
Anything under **Upgrade notes** requires action on the operator's part
(a rebuild, a migration, a config change) before/after updating.

## [Unreleased]

### Added
- Redesigned sidebar as a **two-level, single-viewport** layout: a thin,
  collapsible **rail** (toggle between icon-only and icon + label, remembered)
  for top-level navigation — Library and External sources, plus Connect-a-device,
  Keyboard shortcuts, Admin, and Profile. Selecting a section **slides a wide
  panel in to replace the rail** (with its content — library filters & facets
  (with your Saved searches and Playlists), the sources tree, or the profile
  menu); "Menu" slides back. Replaces the single cramped column (and fixes the
  facets-vs-tools overlap).
- External sources are now a **drag-and-drop tree**: file single-video / live
  sources into categories by dragging (onto a category to group, onto another
  source to reorder), create / rename / delete categories, with Playlists and
  Channels in their own fixed groups.
- A **Profile** panel (account summary + log out; Light/Dark mode and Settings
  are placeholders for later).
- External-source categories: group single-video / live sources into categories
  (e.g. "news", "music", "funny") in the sources manager, then pick a category to
  see all of those live channels together as one grid — Play All or click any tile
  to watch, with prev/next flipping between channels. (Channels/playlists keep
  their own video lists and aren't grouped.)
- Add-to-playlist shortcut (`p`) in the viewer, and the playlist picker is now
  fully keyboard-navigable — ↑/↓ to choose a playlist, Enter to add, Escape to
  close — so you can file items without touching the mouse.
- Face-aware framing: photos are now framed on the people in them. A focal point
  (the centre of the detected faces) is computed during face enrichment and used
  to anchor the thumbnail crop (so faces aren't cut off in the grid) and to
  default the full-screen viewer's pan onto the faces. Works for rotated photos
  too (the crop centres on the faces regardless of orientation). Your manual
  framing still overrides, and items without faces stay centred.
- External sources manager: a second sidebar layer that slides over the sidebar
  column (opened from the "Sources" button) to add, filter, drag-to-reorder,
  rename, and delete your YouTube sources — replacing the cramped dropdown once
  the list grows. It's anchored to the sidebar (no click-away backdrop); a
  "Back" link returns to the main sidebar content.

### Changed
- Slimmed the results toolbar: **Sort** moved into the left sidebar with the
  facets, **Shuffle** now sits right next to **Play**, and the **"Per page"**
  control is gone (infinite scroll handles paging — it was just a fetch-size
  knob). Frees up the row above the grid.
- External sources now show a compact per-kind icon (channel / playlist / video)
  instead of the "CHANNEL/VIDEO" text label, leaving room for the full title.
- The sidebar now widens when the sources manager is open, so source titles and
  the category field have room instead of being cramped in the narrow column.
- Each source's actions (rename, set category, remove) moved into a per-row kebab
  (⋮) menu, so the row is just the drag handle, kind icon, and full title.
- Add-tag flow: adding a tag with Enter now keeps the info panel open with the
  field focused so you can add several tags in a row; Escape finishes and closes.
  (Previously Enter closed the panel but left the hidden field focused, which
  swallowed the next keypress — e.g. `i` typed into the field instead of
  reopening the panel.)
- Opening a YouTube video now focuses the KenNook player overlay instead of the
  embedded iframe, so Escape and other keyboard shortcuts work immediately — no
  longer dead until you click somewhere in the player first.

## [0.3.2] - 2026-07-12

### Added
- The processor-load throttle now governs **every** enrichment pass — Text/VLM,
  Video OCR, Transcript, Transcript Tags, Faces, Vector backfill, Scrub-preview
  (sprites), and Image-preview backfill. Each paces between items and caps its
  core usage live (ONNX thread cap for the AI models, ffmpeg `-threads` for
  sprites, libvips concurrency for image previews), so switching to
  Light/Background lowers CPU on any of them mid-run. Previously only the four
  text/transcript AI passes were affected.
- Enrichment logs now report the processor load: each processed item shows the
  active level next to its timing (e.g. `(1.2s · background)`), and a change to
  the level mid-run is announced in the log so you can see the toggle take effect.
- Toggle-info shortcut (`i`) in the full-screen viewer: shows/hides the details
  (info / tags / bookmarks) sidebar — the same action as the (i) toolbar button.
- Add-tag shortcut (`t`) in the full-screen viewer: opens the info panel with
  the tag field focused and auto-closes it once you add a tag (or press Escape),
  mirroring the bookmark shortcut. Works for photos and videos — the info panel
  now shows tags for photos too.

### Changed
- The enrichment processor-load throttle now applies its **core cap live**: an
  AI model rebuilds with the new core count on the next item after you change the
  level, so switching to Light/Background lowers CPU on an already-running job
  (previously only the pacing took effect live; the core cap needed a restart).
  The item in flight when you switch still finishes at the old cap, and the
  change costs a one-time model reload.
- Reorganized the viewer's details sidebar: the Tags and Bookmarks editors no
  longer render as odd floating boxes inside the panel, tags are no longer
  duplicated (one editor, shown for photos and videos), and editable
  fields/actions are grouped above a divider from the read-only info below.
- Trim in/out shortcuts moved from `i`/`o` to `[`/`]` (freeing `i` for the info
  panel).

### Fixed
- Full-screen viewer chrome (the "coming up" reel, zoom minimap, toolbar) and the
  video controls bar now reliably auto-hide after a (re)load — they no longer
  stay pinned until you interact with them and move away. Both now hide after
  idle regardless of cursor position (Netflix/YouTube-style) instead of trying to
  stay open while "hovered", which got stuck when they mounted under a stationary
  cursor on load. The viewer chrome also no longer stays pinned open because the
  header search bar (which auto-focuses on every load) grabbed focus — the
  keep-open-while-typing rule now only applies to the viewer's own tag/bookmark
  fields, not any input on the page.
- The screensaver now restores after an update-reload: a device that reloads while
  the screensaver is already on reads the persisted state on load and shows it,
  instead of only ever reacting to a live on/off toggle (which never arrives when
  the state hasn't changed since it last looked).
- Sidebar scrolling reworked so the second-level panel can never exceed the
  sidebar: the rail and the panel are now absolute sliding panes each with their
  OWN scroll, bounded to the sidebar's height (viewport minus the live-measured
  header height). Fixes the panel running off-screen, the odd offset scrollbar,
  and the top slipping under the sticky search bar. (The sidebar no longer uses
  CSS `zoom`, which was the source of those glitches.)
- Full-screen viewer chrome (the "coming up" reel + controls) no longer stays
  pinned on screen after reloading a display until you move the mouse — it now
  auto-hides reliably on a cold load.
- The "coming up" reel now shows fewer thumbnails on narrow screens instead of
  running under the side navigation arrows — the number shrinks with the window
  so the controls stay clear and clickable.

## [0.3.1] - 2026-07-12

### Fixed
- Server crash (`ReferenceError: ResizeObserver is not defined`) when
  server-rendering the library page — the virtualized grid's resize hooks now
  run only on the client, so the home page loads again in production.

## [0.3.0] - 2026-07-12

A big release: real multi-user support, external YouTube sources alongside your
libraries, an infinite-scroll virtualized grid, a consolidated sidebar, a
redesigned full-screen viewer, and an admin storage file manager — plus
cross-device sync that keeps every window in step.

### Added
- **External sources (YouTube).** Add a YouTube channel, playlist, or individual
  video / live stream alongside your internal libraries; it shows up in the
  sidebar and browses in the same grid. The built-in player has **Play All**,
  prev/next queue arrows, an autoplay toggle, a **Resume** control, and a
  captions (CC) toggle. Audio solos across windows and devices, and the
  screensaver mutes/pauses external playback too. (Needs a YouTube Data API key
  — see Upgrade notes.)
- **Real multi-user support.** Per-user data (playlists, saved searches, likes,
  watch state), sign-up, an anonymous / kiosk mode, and admin user management
  (create / edit / remove). Sign out from the header; admins can also "sign out
  all sessions."
- **Infinite scroll.** The library grid loads continuously as you scroll,
  virtualized so even very large libraries stay smooth. Choose how many results
  load at a time (default 100) with a per-page selector.
- **Admin storage file manager.** Browse a storage's real folder tree with
  per-file status (indexed / duplicate / ignored / not-yet-indexed), bulk
  ignore / remove / delete, shift-click range select and select-all/none,
  visibility toggles (hidden / ignored / incompatible), duplicate → original
  links, and live "files indexed" counts during a scan.
- **Enrichment throttle.** A UI control to pace background AI enrichment —
  full / light / background presets — so multi-hour jobs don't peg your CPU.
- **Action HUD.** A large ghosted glyph briefly flashes in the center on a
  keyboard shortcut or a background sync event (e.g. another window muting), so
  you can see what just happened.
- **Redesigned viewer.** Media opens straight to full-screen; item details,
  tags, and bookmarks live behind an (i) info panel. Added bookmarks, tags,
  trim, scrub-preview thumbnails, community likes, and watch counts.
- **"Last viewed" highlight + Resume.** The last item you opened is highlighted
  (sky ring) and marked with a chip — in both the library and external sources —
  and a Resume pill jumps you back to it.
- Video **loading spinner** so a slow-to-start video shows progress instead of a
  blank black screen.

### Changed
- **One left sidebar.** The two sidebars are merged into a single left sidebar
  holding the logo, library switcher, playlists (now a dropdown), saved
  searches, and tools/links. It slides open and closed smoothly. The library
  switcher hides when there's only one library, and creating a library is
  admin-only.
- **Big-screen scaling.** The whole app chrome scales up on large / high-res
  displays so items are no longer tiny.
- **Live sidebar sync.** Playlists, saved searches, and external sources now
  refresh across windows and devices the moment one is added — no reload needed.
- **Per-user, not global.** The screensaver and the solo-audio (mute) rule are
  now per-user rather than instance-wide.
- **Face recognition** switched to ArcFace + YuNet for photos; video face
  recognition was removed.
- **Faster re-scans.** The indexer caches every seen file and skips re-hashing
  unchanged, already-indexed files; only browser-viewable formats are indexed
  (tiff / mkv / avi dropped).
- Removed the header **Select** button (hover-to-select replaces it), made the
  pagination bar sticky, and hid empty Playlists / Saved Searches sections.
- Multi-window sync now uses a leader-elected SSE stream + a single cross-process
  state poll per browser (via a localStorage lease, relayed over
  BroadcastChannel), so many open windows no longer exhaust the connection pool.
- Server binds dual-stack (`-H ::`) so it answers both IPv6 and IPv4 clients.
- Screensaver lock: signed-in users dismiss it with their own account password;
  anonymous / kiosk displays use a 4-digit passcode (four boxes), replacing the
  old shared passphrase. A small sign-out link appears at the unlock prompt.
- Slideshow: loop the current video on repeat (toggle with `R` or the controls
  button); slideshow auto-loop is now per-window instead of global.

### Fixed
- Grid no longer gets pushed off-screen when the sidebar toggles.
- Checkbox selection in the file browser no longer needs multiple clicks.
- Viewer chrome (reel / minimap / toolbar) no longer stays pinned on first load.
- Truncated / damaged videos are labeled and salvaged where possible; 0-byte and
  empty files are handled cleanly, and real ffmpeg errors surface.
- The indexer no longer leaks a FileHandle (exifr) and crashes mid-run; progress
  emits are throttled during fast skip runs.
- YouTube video / live links create a single-video source (not the whole
  channel); "Open on YouTube" moved to avoid mis-clicks; player and flow controls
  scale up on big screens.

### Upgrade notes
- This release runs **database migrations** (per-library and user databases) for
  multi-user support and the new features. Rebuild before starting your
  production server: `pnpm build:prod && pnpm start:prod`.
- **External YouTube sources need an API key.** Set `YOUTUBE_API_KEY` (a
  YouTube Data API v3 key, no OAuth) in `.env.local`. Without it the app runs
  fine, but adding a YouTube source will error.
- The screensaver lock is now a 4-digit numeric passcode. On upgrade, an existing
  lock is reset to the default `1234` — change it in Admin → Settings.

## [0.2.2] - 2026-06-21

- Add pnpm commit: one-command commit, release, and deploy

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
