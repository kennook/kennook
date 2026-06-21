# KenNook

Your personal media library, smarter.

Self-hosted, AI-native, privacy-first. Drop it on a folder of photos and videos and search them like you'd search Google — *"beach trips with the kids"*, *"the dog when he was a puppy"* — without uploading a single byte to anyone's cloud.

> **Status:** early (pre-1.0) but self-hostable today. See the
> [latest release](https://github.com/kennook/kennook/releases) and
> [CHANGELOG](CHANGELOG.md) for what's current.

## Prerequisites

- **Node.js 20+**
- **pnpm** (`npm i -g pnpm`)
- **ffmpeg** on PATH (for video frame extraction)
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg` / `dnf install ffmpeg`
  - Windows: `winget install ffmpeg`

## Setup

```bash
pnpm install
cp .env.example .env.local
```

That's it. No database server to install, no Python, no Docker.

## Index a folder

Point the indexer at a folder of photos and/or videos. It walks recursively, generates thumbnails, extracts EXIF, and creates CLIP embeddings for each item.

```bash
pnpm indexer ~/Pictures
```

First run downloads the CLIP model (~250MB) into `./data/models`. Subsequent runs are instant. Indexing speed is roughly 5–20 items/sec on a modern machine, faster on Apple Silicon.

Re-running the indexer is safe — files already indexed (matched by SHA-256) are skipped.

## Run the app

```bash
pnpm dev
```

Open <http://localhost:3000>. Type anything in the search box — natural language works:

- *"sunset"*
- *"dog playing in the snow"*
- *"my kitchen"*
- *"birthday cake"*

Empty search shows your library in capture-date order.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Next.js 15 (App Router) — UI + tRPC server in one process │
│                                                            │
│  src/app/                                                  │
│    page.tsx                  Main page (search + grid)     │
│    api/trpc/[trpc]/route.ts  tRPC HTTP handler             │
│    api/thumbnails/[id]       Thumbnail JPEG endpoint       │
│    api/media/[id]            Original file (range-aware)   │
│                                                            │
│  src/server/                                               │
│    routers/media.ts          list / search / get           │
│                                                            │
│  src/db/                                                   │
│    schema.ts                 Drizzle schema                │
│    client.ts                 SQLite + sqlite-vec + FTS5    │
│                                                            │
│  src/ai/                                                   │
│    embeddings.ts             CLIP via Transformers.js      │
│                                                            │
│  src/indexer/                                              │
│    index.ts                  CLI scanner + pipeline        │
│    ffmpeg.ts                 Video frame extraction        │
└────────────────────────────────────────────────────────────┘

Data:
  data/kennook.db          SQLite database (media_items, embeddings, FTS)
  data/thumbnails/*.jpg    Generated thumbnails (800px max edge)
  data/models/             Cached Transformers.js model files
```

## How search works

Hybrid: vector similarity (semantic) + BM25 full-text + recency, all in one SQL query against SQLite.

1. User query → CLIP text embedding (~50ms)
2. `sqlite-vec` retrieves top-200 by cosine distance
3. `FTS5` rescores by BM25 against filename / caption / transcript / place
4. Final score = `0.7 × visual + 0.3 × text` (tunable)

No separate search server. No Elasticsearch. SQLite handles libraries up to ~500K items comfortably; Postgres + pgvector is the upgrade path beyond that.

## Features

- **Photos + video** indexed from any folder — EXIF (date/GPS/camera), video
  metadata, generated thumbnails/previews, SHA-256 dedup.
- **Semantic + full-text search** — CLIP image embeddings combined with FTS
  into a single ranked result.
- **On-device AI, no cloud** — speech-to-text transcription (whisper.cpp),
  text-in-video/OCR, face detection + people clustering, and automatic
  sensitive-content classification, all run locally.
- **Library UI** — Pinterest-style masonry grid, a fast viewer with zoom/pan
  and slideshow, playlists, saved searches, and people browsing.
- **Multi-device** — real-time sync across devices on your network, a
  walk-away screensaver, and **zero-config access**: KenNook advertises
  `kennook.local` over mDNS and shows a QR to connect any device.
- **Self-hosted & private** — runs entirely on your own machine; optional
  login passwords and an admin Configuration panel.

See [CHANGELOG.md](CHANGELOG.md) and the
[releases](https://github.com/kennook/kennook/releases) for what's new.

## Roadmap

Directional, not dated — track specifics in Issues / Discussions:

- A packaged, double-click desktop app (no terminal required).
- Deeper auto-organization: smart albums, richer tagging, dedup review.
- Fuller multi-user / family mode with real per-user accounts.
- Bring-your-own-storage backends.

## Status & support

KenNook is **early and built by [Moises Romero](https://moisesromero.com)**. 
It's free to self-host, forever. Bug reports are welcome, but support is
best-effort and I'm not taking feature requests yet while the core stabilizes.
Please use **Discussions** for questions and **Issues** for reproducible bugs.

## License

[GNU AGPL-3.0](LICENSE). Free to use, modify, and self-host. If you run a
**modified** version as a network service, the AGPL requires you to offer your
users the source. The managed/cloud edition of KenNook is a separate offering.
