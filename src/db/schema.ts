import { sql } from 'drizzle-orm';
import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

// ─────────────────────────────────────────────────────────────────────────────
// users — single-user v0.1, designed for family multi-user later
// ─────────────────────────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uuid: text('uuid').notNull(),
  email: text('email'),
  displayName: text('display_name'),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  uuidIdx: uniqueIndex('users_uuid_idx').on(t.uuid),
}));

// ─────────────────────────────────────────────────────────────────────────────
// storage_locations — BYOC: local disk, S3, R2, etc.
//
// config.root_path holds the absolute filesystem root for `type:'local'`
// (e.g. "/Volumes/Expansion"). media_items.path is stored *relative* to this
// root so relocations are O(1): point the storage at a new root and every
// row beneath it follows automatically.
// ─────────────────────────────────────────────────────────────────────────────
export type StorageConfig = {
  /** Absolute filesystem path that media_items.path values are relative to. */
  root_path: string;
};

export const storageLocations = sqliteTable('storage_locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['local', 's3', 'r2', 'b2', 'gcs'],
  }).notNull(),
  config: text('config', { mode: 'json' }).$type<StorageConfig>().notNull(),
  isDefault: integer('is_default').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});

// ─────────────────────────────────────────────────────────────────────────────
// media_items — the canonical record per media piece
// ─────────────────────────────────────────────────────────────────────────────
export const mediaItems = sqliteTable('media_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uuid: text('uuid').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),

  storageLocationId: integer('storage_location_id').notNull().references(() => storageLocations.id),
  /** Path relative to storageLocations.config.root_path. Join with the root to get the absolute path. */
  path: text('path').notNull(),
  filename: text('filename').notNull(),

  kind: text('kind', { enum: ['photo', 'video', 'audio', 'document'] }).notNull(),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  /** Video-only: overall bit-rate (bits/sec) and codec name from ffprobe.
   *  Null for photos and for videos indexed before schema v15 (no backfill). */
  videoBitrate: integer('video_bitrate'),
  videoCodec: text('video_codec'),

  sha256: text('sha256'),
  phash: text('phash'),

  capturedAt: integer('captured_at'),
  capturedLat: real('captured_lat'),
  capturedLon: real('captured_lon'),
  capturedPlace: text('captured_place'),
  cameraMake: text('camera_make'),
  cameraModel: text('camera_model'),

  aiCaption: text('ai_caption'),
  aiSummary: text('ai_summary'),
  transcript: text('transcript'),

  embeddingStatus: text('embedding_status', {
    enum: ['pending', 'indexed', 'failed'],
  }).notNull().default('pending'),

  /** Multi-frame video OCR status. 'n/a' for photos. */
  videoTextStatus: text('video_text_status', {
    enum: ['pending', 'done', 'failed', 'n/a'],
  }).notNull().default('pending'),

  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),

  thumbnailPath: text('thumbnail_path'),

  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  deletedAt: integer('deleted_at'),
}, (t) => ({
  uuidIdx: uniqueIndex('media_uuid_idx').on(t.uuid),
  userIdx: index('media_user_idx').on(t.userId),
  kindIdx: index('media_kind_idx').on(t.kind),
  capturedIdx: index('media_captured_idx').on(t.capturedAt),
  sha256Idx: index('media_sha256_idx').on(t.sha256),
}));

export type MediaItem = typeof mediaItems.$inferSelect;
export type NewMediaItem = typeof mediaItems.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// media_text_occurrences — per-frame (OCR) or per-segment (transcript) text
// with timestamps. Drives "match at 1:23" deep-linking in search results.
// media_items.ocr_text / .transcript are denormalized rollups of this table
// kept in sync by the enrichment writers so FTS5 keeps matching unchanged.
// ─────────────────────────────────────────────────────────────────────────────
export const mediaTextOccurrences = sqliteTable('media_text_occurrences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mediaItemId: integer('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['ocr', 'transcript'] }).notNull(),
  /** ms into the timeline; NULL for photo OCR (no timeline). */
  tStartMs: integer('t_start_ms'),
  /** End of this occurrence. NULL when not applicable. */
  tEndMs: integer('t_end_ms'),
  text: text('text').notNull(),
  confidence: real('confidence'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => ({
  itemIdx: index('media_text_occ_item_idx').on(t.mediaItemId),
  sourceIdx: index('media_text_occ_source_idx').on(t.mediaItemId, t.source),
}));

export type MediaTextOccurrence = typeof mediaTextOccurrences.$inferSelect;
export type NewMediaTextOccurrence = typeof mediaTextOccurrences.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Virtual tables (vec0 + fts5) are NOT defined here — Drizzle doesn't model
// them. They're created via raw SQL in src/db/client.ts on first connection.
// We query them with Drizzle's sql`` template.
//
//   media_embeddings (vec0): embedding FLOAT[512]   — rowid links to media_items.id
//   media_fts        (fts5): filename, caption, summary, transcript, place
// ─────────────────────────────────────────────────────────────────────────────

export const EMBEDDING_DIM = 512;
