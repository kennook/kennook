import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const REGISTRY_PATH = path.join(DATA_ROOT, 'libraries.json');
// Pre-rename name; read as a fallback during the transition window. When
// users first start the new build we copy the legacy file to the new path
// and keep both around so an older build can still boot if rolled back.
const LEGACY_REGISTRY_PATH = path.join(DATA_ROOT, 'workspaces.json');

export const DEFAULT_LIBRARY_SLUG = 'personal';
export const COOKIE_NAME = 'kennook_library';
/** Pre-rename cookie name. Read as a fallback; we only ever write COOKIE_NAME. */
export const LEGACY_COOKIE_NAME = 'kennook_workspace';

export interface Library {
  slug: string;
  name: string;
  createdAt: number;
}

interface Registry {
  version: 1;
  libraries: Library[];
}

function ensureDataRoot() {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
}

function readRegistry(): Registry {
  ensureDataRoot();

  // One-time migration: legacy `workspaces.json` → `libraries.json`. The
  // legacy file is preserved (not deleted) so an older build remains bootable
  // if we have to roll back.
  if (!fs.existsSync(REGISTRY_PATH) && fs.existsSync(LEGACY_REGISTRY_PATH)) {
    try {
      const legacyRaw = fs.readFileSync(LEGACY_REGISTRY_PATH, 'utf8');
      const legacy = JSON.parse(legacyRaw) as { version: 1; workspaces?: Library[]; libraries?: Library[] };
      const migrated: Registry = {
        version: 1,
        libraries: legacy.libraries ?? legacy.workspaces ?? [],
      };
      writeRegistry(migrated);
      return migrated;
    } catch {
      // Fall through to the empty-init path if the legacy file is corrupt.
    }
  }

  if (!fs.existsSync(REGISTRY_PATH)) {
    const initial: Registry = {
      version: 1,
      libraries: [
        { slug: DEFAULT_LIBRARY_SLUG, name: 'Personal', createdAt: Date.now() },
      ],
    };
    writeRegistry(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw) as Registry;
  } catch {
    throw new Error(`Could not parse ${REGISTRY_PATH}. Delete it to reset, or repair it manually.`);
  }
}

function writeRegistry(registry: Registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function listLibraries(): Library[] {
  return readRegistry().libraries;
}

export function getLibraryBySlug(slug: string): Library | null {
  return readRegistry().libraries.find((w) => w.slug === slug) ?? null;
}

export function resolveLibrary(slug: string | undefined | null): Library {
  const wanted = slug ?? DEFAULT_LIBRARY_SLUG;
  const found = getLibraryBySlug(wanted);
  if (found) return found;
  // Fall back to default if requested library doesn't exist.
  const fallback = getLibraryBySlug(DEFAULT_LIBRARY_SLUG);
  if (!fallback) throw new Error('Default library missing from registry');
  return fallback;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export interface CreateLibraryArgs {
  name: string;
  /** Absolute path to the first storage_location for this library. Required —
   *  a library with no storage can't do anything useful. */
  root_path: string;
  /** Human-readable label for the first storage. Defaults to the library name. */
  storage_name?: string;
}

export function createLibrary(args: CreateLibraryArgs): Library {
  const trimmed = args.name.trim();
  if (!trimmed) throw new Error('Library name is required');
  const slug = slugify(trimmed);
  if (!slug) throw new Error('Library name must contain at least one letter or number');

  const rootPathTrimmed = args.root_path.trim();
  if (!rootPathTrimmed) throw new Error('Root path is required');
  const absRoot = path.resolve(rootPathTrimmed);
  if (!fs.existsSync(absRoot)) throw new Error(`root path does not exist: ${absRoot}`);
  if (!fs.statSync(absRoot).isDirectory()) throw new Error(`root path is not a directory: ${absRoot}`);

  const registry = readRegistry();
  if (registry.libraries.some((w) => w.slug === slug)) {
    throw new Error(`Library "${slug}" already exists`);
  }

  const library: Library = { slug, name: trimmed, createdAt: Date.now() };
  registry.libraries.push(library);
  writeRegistry(registry);

  // Pre-create library directories so the indexer + DB init don't race.
  fs.mkdirSync(libraryThumbnailsDir(slug), { recursive: true });

  // Insert the first storage_location in the new library's DB. We do this
  // here rather than in the tRPC router so any code path that creates a
  // library — CLI, API, tests — ends up with a usable storage.
  // Imported lazily to avoid a circular import (storage.ts imports types
  // from this file).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getRawSqlite } = require('@/db/client') as typeof import('@/db/client');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createStorage } = require('./storage') as typeof import('./storage');
  try {
    const sqlite = getRawSqlite(slug);
    createStorage(sqlite, {
      name: args.storage_name?.trim() || trimmed,
      root_path: absRoot,
    });
  } catch (err) {
    // Roll back the registry entry so the user can retry with a different
    // path without hitting "Library already exists".
    const rolled = registry.libraries.filter((w) => w.slug !== slug);
    writeRegistry({ ...registry, libraries: rolled });
    throw err;
  }

  return library;
}

export function libraryRoot(slug: string): string {
  return path.join(DATA_ROOT, slug);
}

export function libraryDbPath(slug: string): string {
  return path.join(libraryRoot(slug), 'kennook.db');
}

export function libraryThumbnailsDir(slug: string): string {
  return path.join(libraryRoot(slug), 'thumbnails');
}

export function parseLibraryCookie(cookieHeader: string | null | undefined): string {
  if (!cookieHeader) return DEFAULT_LIBRARY_SLUG;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  // Prefer the new name; fall back to the legacy `kennook_workspace`
  // so existing tabs/sessions keep their library on first reload.
  for (const name of [COOKIE_NAME, LEGACY_COOKIE_NAME]) {
    const match = cookies.find((c) => c.startsWith(`${name}=`));
    if (match) {
      const v = decodeURIComponent(match.slice(name.length + 1));
      if (v) return v;
    }
  }
  return DEFAULT_LIBRARY_SLUG;
}
