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
// ─────────────────────────────────────────────────────────────────────────────
export const storageLocations = sqliteTable('storage_locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  type: text('type', {
    enum: ['local', 's3', 'r2', 'b2', 'gcs'],
  }).notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
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
  path: text('path').notNull(),
  filename: text('filename').notNull(),

  kind: text('kind', { enum: ['photo', 'video', 'audio', 'document'] }).notNull(),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),

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
// Virtual tables (vec0 + fts5) are NOT defined here — Drizzle doesn't model
// them. They're created via raw SQL in src/db/client.ts on first connection.
// We query them with Drizzle's sql`` template.
//
//   media_embeddings (vec0): embedding FLOAT[512]   — rowid links to media_items.id
//   media_fts        (fts5): filename, caption, summary, transcript, place
// ─────────────────────────────────────────────────────────────────────────────

export const EMBEDDING_DIM = 512;
