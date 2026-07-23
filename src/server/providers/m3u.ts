/**
 * M3U / IPTV playlist provider — no token. Import a public M3U playlist (e.g. an
 * iptv-org list) as ONE source whose "items" are its channels; each channel is a
 * live HLS stream that plays in the native player, so you can browse a big
 * channel list and flip between them.
 *
 * Only `.m3u` playlists are claimed here — a lone `.m3u8` is a single HLS stream
 * (the `stream` provider). Reliability of individual channels varies (dead / geo-
 * blocked / CORS-restricted for browser playback); dead ones simply fail to play
 * and the rest keep working.
 */

import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo, ProviderPage } from './types';

const PAGE = 100;                 // channels per page (playlists can have thousands)
const CACHE_TTL_MS = 10 * 60_000; // re-parse a feed at most every 10 min

interface Channel { url: string; name: string; logo: string; group: string }

// Parsed-playlist cache so paging through a 5k-channel list doesn't refetch +
// reparse the whole (multi-MB) file per page. Keyed by feed URL.
const cache = new Map<string, { channels: Channel[]; at: number }>();

async function fetchPlaylist(url: string): Promise<Channel[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.channels;

  const res = await fetch(url, { headers: { 'user-agent': 'KenNook/1.0 (+external-sources)' } });
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status}).`);
  const text = await res.text();
  if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
    throw new Error('Not a valid M3U playlist.');
  }
  const channels = parseM3U(text);
  if (channels.length === 0) throw new Error('No channels found in this playlist.');
  cache.set(url, { channels, at: Date.now() });
  return channels;
}

const attr = (line: string, name: string): string => {
  const m = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
};

function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const out: Channel[] = [];
  let pending: { name: string; logo: string; group: string } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name = (line.split(',').pop() ?? '').trim();
      pending = { name: name || 'Channel', logo: attr(line, 'tvg-logo'), group: attr(line, 'group-title') };
    } else if (line.startsWith('#')) {
      continue; // other directives (#EXTVLCOPT, #EXTGRP, comments) — ignore
    } else if (pending) {
      out.push({ url: line, name: pending.name, logo: pending.logo, group: pending.group });
      pending = null;
    }
    // A bare URL with no preceding #EXTINF is skipped (no metadata to show).
  }
  return out;
}

function toItem(c: Channel): ProviderVideo {
  return {
    videoId: c.url,
    title: c.name,
    thumbnailUrl: c.logo,
    channelTitle: c.group,
    publishedAt: '',
    playerKind: 'native',
    mediaUrl: c.url,
    isLive: true,
  };
}

function nameFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return last.replace(/\.m3u$/i, '') || 'IPTV playlist';
  } catch { return 'IPTV playlist'; }
}

export const m3uProvider: Provider = {
  id: 'm3u',
  label: 'IPTV / M3U playlist',
  urlHint: 'https://iptv-org.github.io/iptv/index.m3u',

  match(url) {
    // `.m3u` (playlist) but NOT `.m3u8` (a single HLS stream → stream provider).
    return /\.m3u(\?|#|$)/i.test(url.trim());
  },

  async resolve(url, opts) {
    const clean = url.trim();
    const channels = await fetchPlaylist(clean); // validates + warms the cache
    return {
      kind: 'playlist',
      ref: clean,
      playlistId: clean,
      name: (opts?.name?.trim()) || `${nameFromUrl(clean)} (${channels.length})`,
      playerKind: 'native',
      meta: { feedUrl: clean },
    };
  },

  async fetchPage(source: ExternalSource, cursor?: string, filter?: string): Promise<ProviderPage> {
    const url = String(source.meta?.feedUrl ?? source.playlistId ?? source.ref);
    const all = await fetchPlaylist(url);
    // Server-side filter over the WHOLE playlist (name or group), so a search in
    // a 5k-channel list finds matches beyond the loaded pages.
    const f = (filter ?? '').trim().toLowerCase();
    const channels = f
      ? all.filter((c) => c.name.toLowerCase().includes(f) || c.group.toLowerCase().includes(f))
      : all;
    const start = cursor ? parseInt(cursor, 10) || 0 : 0;
    const slice = channels.slice(start, start + PAGE);
    const next = start + PAGE;
    return {
      items: slice.map(toItem),
      nextCursor: next < channels.length ? String(next) : undefined,
    };
  },

  async fetchVideo(source: ExternalSource): Promise<ProviderVideo> {
    const url = String(source.meta?.feedUrl ?? source.ref);
    const channels = await fetchPlaylist(url);
    if (!channels[0]) throw new Error('Playlist has no channels.');
    return toItem(channels[0]);
  },
};
