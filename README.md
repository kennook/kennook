# Kennook

Your personal media library, smarter.

Self-hosted, AI-native, privacy-first. Drop it on a folder of photos and videos and search them like you'd search Google — *"beach trips with the kids"*, *"the dog when he was a puppy"* — without uploading a single byte to anyone's cloud.

> **Status:** v0.1 — first runnable cut. Photos + videos, local CLIP embeddings, hybrid search, web UI.

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

## v0.1 scope

**Included:**
- Photo + video indexing
- CLIP image embeddings (512-dim, `Xenova/clip-vit-base-patch32`)
- EXIF extraction (date, GPS, camera)
- Video metadata via ffprobe; one-frame thumbnail via ffmpeg
- SHA-256 deduplication
- Hybrid semantic + full-text search
- Web UI with grid + viewer modal
- Video playback with HTTP range requests

**Deferred to later:**
- Multi-frame video embeddings → v0.2
- Audio transcription (Whisper) → v0.2
- Auto-captioning (Moondream / Florence-2) → v0.3
- Face clustering → v0.4 (privacy-sensitive)
- Collections / albums → v0.3
- Multi-user / family mode → v0.5
- Native mobile apps → post-PMF
- Plugin SDK → v2+

## Roadmap

| Version | Focus |
|---|---|
| 0.1 | Single-folder photo+video, semantic search, web UI (this) |
| 0.2 | Whisper transcription, multi-frame video embeddings, watch mode |
| 0.3 | Smart albums, auto-tagging, collections |
| 0.5 | Multi-user, BYOC (S3/R2 backends) |
| 1.0 | Polished UI, PWA, paid Pro tier |
