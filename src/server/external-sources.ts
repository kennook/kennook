/**
 * External sources registry — the "external" half of the internal-libraries vs
 * external-sources division. Unlike a Library (a local folder that gets indexed
 * + AI-enriched), an external source is a live connection to a provider
 * (currently YouTube channels/playlists). Its videos are fetched on demand from
 * the provider API and NEVER stored in a per-library media DB.
 *
 * Stored in its own JSON registry (data/external-sources.json), parallel to
 * data/libraries.json, so the two realms stay cleanly separated.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const REGISTRY_PATH = path.join(DATA_ROOT, 'external-sources.json');

export type ExternalProvider = 'youtube';
export type ExternalSourceKind = 'channel' | 'playlist' | 'video';

export interface ExternalSource {
  slug: string;
  name: string;
  provider: ExternalProvider;
  kind: ExternalSourceKind;
  /** Canonical provider ref (YouTube channelId or playlistId). */
  ref: string;
  /** The concrete playlist to page through (a channel's "uploads" playlist),
   *  resolved once at creation so fetches don't re-resolve. */
  playlistId: string;
  createdAt: number;
}

interface Registry {
  version: 1;
  sources: ExternalSource[];
}

function ensureDataRoot() {
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
}

function readRegistry(): Registry {
  ensureDataRoot();
  if (!fs.existsSync(REGISTRY_PATH)) {
    const init: Registry = { version: 1, sources: [] };
    writeRegistry(init);
    return init;
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    throw new Error(`Could not parse ${REGISTRY_PATH}. Delete it to reset, or repair it manually.`);
  }
}

function writeRegistry(r: Registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2) + '\n', 'utf8');
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function listExternalSources(): ExternalSource[] {
  return readRegistry().sources;
}

export function getExternalSource(slug: string): ExternalSource | null {
  return readRegistry().sources.find((s) => s.slug === slug) ?? null;
}

export function addExternalSource(input: Omit<ExternalSource, 'slug' | 'createdAt'>): ExternalSource {
  const reg = readRegistry();
  const base = slugify(input.name) || input.provider;
  let slug = base;
  let i = 2;
  while (reg.sources.some((s) => s.slug === slug)) slug = `${base}-${i++}`;
  const src: ExternalSource = { ...input, slug, createdAt: Date.now() };
  reg.sources.push(src);
  writeRegistry(reg);
  return src;
}

export function removeExternalSource(slug: string): void {
  const reg = readRegistry();
  reg.sources = reg.sources.filter((s) => s.slug !== slug);
  writeRegistry(reg);
}

/**
 * Persist a new display order. `slugs` is the desired order; any registry source
 * not named is appended in its existing order, and unknown slugs are ignored —
 * so a stale client can't drop or duplicate sources.
 */
export function reorderExternalSources(slugs: string[]): ExternalSource[] {
  const reg = readRegistry();
  const bySlug = new Map(reg.sources.map((s) => [s.slug, s]));
  const ordered: ExternalSource[] = [];
  for (const slug of slugs) {
    const s = bySlug.get(slug);
    if (s) { ordered.push(s); bySlug.delete(slug); }
  }
  for (const s of reg.sources) if (bySlug.has(s.slug)) ordered.push(s); // leftovers, original order
  reg.sources = ordered;
  writeRegistry(reg);
  return reg.sources;
}

/** Rename a source (its display title). No-op if the slug is unknown. */
export function renameExternalSource(slug: string, name: string): ExternalSource | null {
  const reg = readRegistry();
  const src = reg.sources.find((s) => s.slug === slug);
  if (!src) return null;
  src.name = name;
  writeRegistry(reg);
  return src;
}
