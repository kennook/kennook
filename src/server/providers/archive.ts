/**
 * Internet Archive provider — no token. Resolves an archive.org item
 * (archive.org/details/<id>) via the open metadata API and plays its media files
 * directly in the native player. A single movie → a `video` source; a multi-file
 * item (audio album, multi-part film) → a `playlist` source whose files are the
 * items. Thumbnails come from the archive's image service.
 */

import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo, ProviderPage } from './types';

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|flac|m4a|wav)$/i;

interface ArchiveFile { name: string; title?: string; format?: string; source?: string }
interface ArchiveMeta {
  metadata?: { identifier?: string; title?: string; creator?: string | string[]; mediatype?: string };
  files?: ArchiveFile[];
}

function extractId(url: string): string | null {
  const clean = url.trim();
  // Bare identifier (no scheme, no dots that look like a domain).
  if (!/^https?:\/\//i.test(clean) && !clean.includes('/') && !clean.includes('.')) return clean;
  try {
    const u = new URL(clean);
    if (!u.hostname.endsWith('archive.org')) return null;
    const m = u.pathname.match(/^\/(?:details|download|embed|metadata)\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

async function fetchMeta(id: string): Promise<ArchiveMeta> {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Internet Archive item "${id}" not found (${res.status}).`);
  const data = await res.json() as ArchiveMeta;
  if (!data.metadata) throw new Error(`Internet Archive item "${id}" has no metadata.`);
  return data;
}

function playableFiles(meta: ArchiveMeta): ArchiveFile[] {
  return (meta.files ?? []).filter((f) => VIDEO_EXT.test(f.name) || AUDIO_EXT.test(f.name));
}

function toItem(id: string, file: ArchiveFile, meta: ArchiveMeta): ProviderVideo {
  const creator = meta.metadata?.creator;
  return {
    videoId: `${id}/${file.name}`,
    title: file.title || file.name.replace(/\.[a-z0-9]+$/i, ''),
    thumbnailUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    channelTitle: Array.isArray(creator) ? creator[0] ?? '' : creator ?? '',
    publishedAt: '',
    playerKind: 'native',
    mediaUrl: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(file.name)}`,
  };
}

export const archiveProvider: Provider = {
  id: 'archive',
  label: 'Internet Archive',
  urlHint: 'https://archive.org/details/<id>',

  match(url) {
    try { return new URL(url.trim()).hostname.endsWith('archive.org'); } catch { return false; }
  },

  async resolve(url, opts) {
    const id = extractId(url);
    if (!id) throw new Error('Not a recognized archive.org item URL.');
    const meta = await fetchMeta(id);
    const files = playableFiles(meta);
    if (files.length === 0) throw new Error('No playable audio/video in this Archive item.');
    const name = (opts?.name?.trim()) || meta.metadata?.title || id;
    // Prefer a video derivative for a single-item ("video") source; multiple
    // files (album / parts) become a pageable playlist.
    const videos = files.filter((f) => VIDEO_EXT.test(f.name));
    const single = meta.metadata?.mediatype === 'movies' ? videos.length <= 1 : files.length <= 1;
    return {
      kind: single ? 'video' : 'playlist',
      ref: id,
      playlistId: id,
      name,
      playerKind: 'native',
      meta: { archiveId: id },
    };
  },

  async fetchPage(source: ExternalSource): Promise<ProviderPage> {
    const id = String(source.meta?.archiveId ?? source.playlistId ?? source.ref);
    const meta = await fetchMeta(id);
    return { items: playableFiles(meta).map((f) => toItem(id, f, meta)), nextCursor: undefined };
  },

  async fetchVideo(source: ExternalSource): Promise<ProviderVideo> {
    const id = String(source.meta?.archiveId ?? source.ref);
    const meta = await fetchMeta(id);
    const files = playableFiles(meta);
    // Prefer an mp4, else the first playable file.
    const best = files.find((f) => /\.mp4$/i.test(f.name)) ?? files[0];
    if (!best) throw new Error('No playable audio/video in this Archive item.');
    return toItem(id, best, meta);
  },
};
