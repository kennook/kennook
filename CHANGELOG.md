# Changelog

All notable, user-facing changes to KenNook are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, **MINOR** bumps may include breaking changes; **PATCH** is fixes only.

Cut a release with `pnpm release <patch|minor|major>` — see `RELEASING.md`.
Anything under **Upgrade notes** requires action on the operator's part
(a rebuild, a migration, a config change) before/after updating.

## [Unreleased]

- **Slower slideshows.** The per-photo dwell time now goes up to 60 seconds (was
  30) — set it on the slideshow speed slider or with the `,` / `.` keys.
- **Shortcuts work the instant a video opens full screen.** Opening a result
  (especially a video) left keyboard focus on the search bar behind the viewer,
  so shortcuts did nothing until you clicked a control first. Full-screen viewer
  shortcuts now fire immediately regardless of where focus lingered — and the
  keys no longer leak into the hidden search box.
- **No more ghostly controls after the screensaver.** When the screensaver was
  dismissed — especially from another device — the full-screen controls (and the
  thumbnail reel) could linger half-faded, stuck mid-fade, instead of settling.
  The controls now snap cleanly to their correct state the instant the
  screensaver clears.

## [0.5.1] - 2026-08-10

- **Search no longer hitches the whole app.** Running a search briefly froze
  everything else the server was doing — other windows' thumbnails, video, and
  live updates would stall for a beat while the search ran its AI matching (the
  query's semantic embedding ran on the server's single thread, blocking every
  other request). That step now runs in a separate process, so searching in one
  window no longer stalls the others. Identical queries (and multiple screens
  searching the same thing) now share one computation, too.

## [0.5.0] - 2026-08-06

- **Silent updates while the screensaver is up.** If a new version starts running
  while the screensaver is active, the display reloads onto it silently instead of
  showing a reload banner — the screensaver simply comes back on the new build, so
  an always-on screen keeps itself current without anyone touching it.
- **Screensaver hides everything underneath.** While the screensaver is up, the
  rest of the app is now truly hidden (not just covered) — so if the screensaver
  is ever removed by other means, the private content underneath isn't exposed.
- **Overall rating stays put.** In the grid, an item's overall (average) rating
  no longer disappears when you add your own rating — it stays visible alongside
  your personal heart.
- **Nicer tooltips.** Control tooltips are no longer the browser's slow, tiny
  native ones — they appear quickly, are clearly styled, and scale up on large
  displays so they stay readable instead of shrinking to a footnote. Applies
  everywhere automatically.
- **Sound stays on across a reload.** The window you last turned sound on in now
  comes back unmuted after a reload, instead of always starting muted. It's
  remembered per-window (so muted windows and other screens stay muted, and only
  one window ever plays audio — the solo-audio rule is unchanged). Browsers block
  unmuted autoplay on a fresh load unless they've granted the site sound, so this
  restores audio only when the browser permits it; otherwise it stays muted (no
  workarounds that fight the browser). Works for local videos and native streams
  (HLS / audio); embedded players (YouTube, Twitch, Vimeo) keep the ownership
  accurate but still follow their platform's autoplay rules.
- **Reshuffle from full screen.** While shuffle is on, the viewer shows a
  reshuffle button that mints a fresh random order without leaving full screen,
  keeping the item you're watching pinned to the top. If a filter (e.g.
  "unwatched") excludes that item from the new order, the viewer now continues
  from the new first item instead of getting stuck.

## [0.4.0] - 2026-07-31

- **Per-drive activity indicator.** In the storage admin's drive list, a drive with
  a running or queued job now pulses its icon and shows a small spinner — so you can
  see which drives are working at a glance (handy now that multiple drives can index
  in parallel).
- **Hover-to-preview videos in the grid.** Rest the cursor on a video thumbnail
  and it plays a quick silent traversal of the clip (built from the existing
  scrub-preview sprite sheet) — a fast way to see what a video is before opening
  it. Kicks in after a short dwell so scrolling past tiles doesn't trigger it, and
  falls back to the static thumbnail for videos that haven't been scrubbed yet.
- **Parallel jobs across drives.** The admin job runner can now index multiple
  drives at the same time instead of strictly one job at a time. I/O-bound work
  (indexing, previews, scrub sprites) runs several in parallel (up to 3, one per
  drive) while the CPU/AI-heavy enrichment passes stay serialized — so you get
  faster multi-drive indexing without overloading the processor, and the
  processor-load throttle keeps working exactly as before. Pause/resume and cancel
  operate across all running jobs.
- **Configurable hot corners (macOS-style).** Map each of the four screen corners
  to an action in **Profile → Settings → Hot corners**: fling the cursor into a
  corner to **start the screensaver**, or set a corner to **Hide controls** (the
  mouse-jiggler-friendly "let the controls fade" behavior). The mapping is synced
  to your account across devices. By default the top-left corner keeps the
  hide-controls behavior, so nothing changes unless you customize it. More corner
  actions (shuffle, slideshow, sidebar) can be added over time.
- **External sources are no longer YouTube-only.** A new provider framework lets
  you add public sources with no per-account login: **direct / HLS streams** (paste
  a live `.m3u8`, a radio `.mp3`, or an `.mp4` — great for live channels on the
  screensaver), **RSS / podcast feeds** (audio + video, including YouTube-channel
  RSS with no API key), and **Internet Archive** items (public-domain movies, music,
  TV), plus **Vimeo** (single videos need no token; channels use one app token)
  and **Twitch** (channels + VODs — playback needs no token; an optional app token
  just gives nicer names). Native media plays in a built-in player (HLS via hls.js,
  audio with artwork); Vimeo/Twitch play via their official embeds. All of them are
  first-class KenNook citizens — queue auto-advance, solo-audio handoff across
  devices, and screensaver suspend work everywhere. No per-account logins.
- **IPTV / M3U playlist import.** Paste a public M3U playlist URL (e.g. an
  [iptv-org](https://github.com/iptv-org/iptv) list) and it imports as one source
  whose channels you can browse and flip between — live TV on the screensaver, no
  account. Live HLS streams now route through a **built-in CORS proxy**, so most
  channels that a browser would otherwise block for cross-origin reasons now play.
  (Some channels are still just dead or geo-blocked — those can't be fixed.)
- **Storage admin redesigned as a Disk-Utility-style, per-drive view.** Drives are
  listed down the left (Internal / External / Cloud); selecting one shows its own
  panel — a capacity bar (this library's footprint vs other data vs free), indexed
  stats, Browse/Relocate/Remove, a **run tree**, and a job log scoped to just that
  drive. Enrichment/backfill can now be **run per drive** — each step scopes to
  one storage, and its pending counts + ETAs reflect just that drive. The old flat
  "Run ▾" list is replaced by a **hierarchical run tree** (Index → Backfill →
  Enrich) with live per-node status; steps run one at a time and a step shows
  "waiting" until its prerequisites finish (if a prerequisite fails, dependent
  steps are skipped). Each node also shows its **last run** — e.g. "completed
  yesterday @ 11:03 AM" or "failed 2 days ago @ 5:12 PM".
- **Your tags and bookmarks now count in search.** Searching a word that matches
  one of your tags or a bookmark label now surfaces that item — previously tags
  weren't indexed at all and bookmark-only matches never appeared (search only
  looked at items the semantic/keyword pass already found). Manual (user-added)
  tags and bookmarks are ranked **well above** automated AI tags, so a deliberate
  label wins over an incidental one.
- **Damaged-file warning.** When an item's preview can't be loaded (a strong sign
  the source is missing or corrupt), its grid tile now shows a small ⚠ badge with
  a tooltip explaining it may be damaged. And if a video fails to play in the
  full-screen viewer, you get a clear "This video couldn't be played" message
  instead of a black screen.
- Redesigned sidebar as a **two-level, single-viewport** layout: a thin,
  collapsible **rail** (toggle between icon-only and icon + label, remembered)
  for top-level navigation — Library and External sources, plus Connect-a-device,
  Keyboard shortcuts, Admin, and Profile. Selecting a section **slides a wide
  panel in to replace the rail** (with its content — library filters & facets
  (with your Saved searches and Playlists), the sources tree, or the profile
  menu); "Menu" slides back. Replaces the single cramped column (and fixes the
  facets-vs-tools overlap).
- External sources are now a **drag-and-drop tree** split into three groups —
  **Live Channels**, **Channels**, and **Playlists**. Only Live Channels supports
  categories + reordering (drag a source onto a category to group it, or onto
  another to reorder; create / rename / delete categories); Channels and Playlists
  carry their own video lists, so they stay as fixed, non-reorderable groups.
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
- Face-aware framing now centers on the **largest face** (the main subject)
  instead of the center of *all* faces — the old average landed in the empty gap
  between people spread across a photo. New photos use it automatically; apply it
  to your existing library with `pnpm exec tsx scripts/face-focus.ts --recompute`
  (no re-detection needed).
- Slimmed the results toolbar: **Sort** moved into the left sidebar with the
  facets, **Shuffle** now sits right next to **Play**, and the **"Per page"**
  control is gone (infinite scroll handles paging — it was just a fetch-size
  knob). Frees up the row above the grid.
- **Shuffle now works like Spotify.** Turning it on reshuffles the whole result
  set into a fresh playlist but pins the item you were on (the one you're
  viewing, else the last one you opened, else the first result) to the top — so
  Play walks the new order from where you are. While shuffle is on it's clearly
  active and the sidebar **Sort** control turns into a one-click "Shuffled ·
  turn off" button (so you can restore sorting right there instead of crossing
  back to the shuffle toggle); turning it off restores your previous sort and
  order. Shuffle is also available **inside the full-screen viewer** (a toolbar
  toggle), so you can reshuffle the "coming up" order — pinning the item you're
  on — without exiting.
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
- Dismissing the screensaver no longer sometimes leaves the **slideshow paused**.
  The screensaver used to pause the auto-advance by flipping the play/pause state
  and restoring it on dismiss — a fragile save/restore that could get stuck off.
  It now freezes the auto-advance directly while the screensaver is up without
  touching your play/pause intent, so it always resumes as it was.
- Silenced a spurious "The play() request was interrupted by a call to pause()"
  error — a benign race (a quick pause, or the screensaver engaging, before a
  `play()` resolved) that was surfacing as a runtime error. Play calls now handle
  it, and an in-flight resume is canceled if the screensaver re-engages.
- Videos now reliably resume after dismissing the screensaver. Previously the
  resume could fail silently if the source drive had spun down (or a live stream
  re-buffered) while the screensaver was up — the browser's `play()` rejects when
  the media isn't ready, and nothing retried. It now retries until the drive/
  stream wakes up.
- The search bar now works as a **filter inside external sources**. Previously,
  searching while viewing a YouTube channel / playlist / IPTV list searched the
  local library instead (and kicked you out of the source). Now, under an external
  source it filters that source's videos/channels by title as you type, and leaves
  the local-library search unchanged everywhere else. For **IPTV / M3U playlists**
  the filter runs on the server across the *entire* channel list (not just the
  loaded page), so a search finds matches anywhere in a multi-thousand-channel
  list.
- Fixed a grid crash ("No data was found at index N") that could fire when the
  result list got shorter without a filter change — e.g. excluding/deleting an
  item, or a transient duplicate being de-duped mid-scroll. The virtualized grid
  now re-lays-out when the item count shrinks instead of throwing.
- **Jobs weren't actually running** (regression from the parallel-jobs change):
  the pool claimed each job twice, so the row flipped to "running" but no process
  ever spawned — it just sat there with no output and couldn't be canceled ("no
  live process for this job"). Fixed the double-claim so jobs run again, and Cancel
  now clears a stuck/orphaned "running" row instead of erroring.
- The "This video couldn't be played" message now has a **Retry** button. The
  browser fires the error on transient hiccups too (a drive spinning up, a brief
  stall), so a reload often succeeds — no need to close and reopen the video.
- Fixed a rare crash ("Cannot read properties of undefined (reading 'item')") in
  the results grid when the dataset changed (shuffle / filter / library switch) —
  the virtualized grid could momentarily index past the new item list. It now
  guards against the transient instead of throwing.
- The full-screen "coming up" reel now hides more aggressively on narrow and
  **portrait** screens — down to 2–3 thumbnails (from up to 5) — so the strip no
  longer covers the side arrows or the bottom-left controls. Wide landscape
  screens are unchanged.
- Switching libraries now clears the **Resume** pill. Previously, if you'd been
  watching results and switched libraries (with no filters set), the resume pill
  lingered and reopened the *old* library's clip. The resume point now resets on a
  library switch, since it belongs to that library's result set.
- Enrichment jobs now log the **processor-load level up front**, when the job
  starts, instead of only after the first item finishes. On heavy passes
  (`enrich:text` downloads a ~250 MB model and runs multi-second inference on item
  one) the level otherwise didn't appear in the log until minutes in — reading as
  "not logging." Also added the missing throttle log to the sensitive-scoring pass.
- Opening a photo/video in full screen now enables keyboard shortcuts immediately
  — no more clicking the video first. The header search bar auto-focuses, and on
  macOS clicking a grid tile doesn't move focus off it, so shortcuts were being
  swallowed by the still-focused search field until you clicked the video. The
  viewer now takes focus itself on open (moving it off any input), so shortcuts
  work the instant it appears.
- The sidebar's **"Reset all filters"** now actually clears everything. It was
  firing each filter's clear separately, and those back-to-back URL writes
  clobbered each other (only the last survived), so it usually did nothing. It
  now clears all filters in a single update.
- Fixed a React "cannot update a component while rendering a different one"
  warning from the video player: the solo-audio HUD flash was fired inside a
  `setMuted` state updater (which runs during render). It now checks the previous
  mute state via a ref and flashes outside the updater.
- Fixed a "two children with the same key" error (and the occasional duplicated /
  missing thumbnail) in the results grid: result orderings now end with a unique
  tiebreak, so ties (shuffle collisions, equal dates/likes) can't let an item
  straddle a page boundary and load twice. The grid also de-dups defensively.
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
