/**
 * Twitch provider. Playback needs NO token — the embed player plays a channel
 * (live) or a VOD given just the id + the embedding host (handled client-side).
 * An optional app token (TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET, client-
 * credentials) only enriches the display name / thumbnail. Plays via the Twitch
 * embed (playerKind 'twitch').
 */

import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo, ProviderPage } from './types';

interface ParsedTwitch { kind: 'channel' | 'video'; ref: string }

function parseTwitch(url: string): ParsedTwitch | null {
  try {
    const u = new URL(url.trim());
    if (!u.hostname.endsWith('twitch.tv')) return null;
    const vod = u.pathname.match(/^\/videos\/(\d+)/);
    if (vod) return { kind: 'video', ref: vod[1] };
    const chan = u.pathname.match(/^\/([A-Za-z0-9_]{2,40})\/?$/);
    if (chan && !['videos', 'directory', 'settings', 'p'].includes(chan[1].toLowerCase())) {
      return { kind: 'channel', ref: chan[1] };
    }
    return null;
  } catch { return null; }
}

// ── Optional Helix app token (client-credentials), cached across calls. ──
let tokenCache: { token: string; expiresAt: number } | null = null;
async function helixToken(): Promise<string | null> {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

async function helix<T>(path: string): Promise<T | null> {
  const token = await helixToken();
  const id = process.env.TWITCH_CLIENT_ID;
  if (!token || !id) return null;
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { authorization: `Bearer ${token}`, 'client-id': id },
  });
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

async function channelMeta(login: string): Promise<{ name: string; thumb: string }> {
  const users = await helix<{ data?: Array<{ display_name?: string; profile_image_url?: string }> }>(`users?login=${encodeURIComponent(login)}`);
  const u = users?.data?.[0];
  return { name: u?.display_name ?? login, thumb: u?.profile_image_url ?? '' };
}

function toItem(source: ExternalSource): ProviderVideo {
  const isChannel = source.meta?.twitchKind === 'channel';
  return {
    videoId: source.ref,
    title: source.name,
    thumbnailUrl: String(source.meta?.thumbnailUrl ?? ''),
    channelTitle: '',
    publishedAt: '',
    playerKind: 'twitch',
    isLive: isChannel,
  };
}

export const twitchProvider: Provider = {
  id: 'twitch',
  label: 'Twitch',
  urlHint: 'https://twitch.tv/<channel>',

  match(url) {
    try { return new URL(url.trim()).hostname.endsWith('twitch.tv'); } catch { return false; }
  },

  async resolve(url, opts) {
    const parsed = parseTwitch(url);
    if (!parsed) throw new Error('Not a recognized Twitch channel or VOD URL.');
    let name = opts?.name?.trim() || (parsed.kind === 'video' ? `Twitch VOD ${parsed.ref}` : parsed.ref);
    let thumb = '';
    if (parsed.kind === 'channel') {
      const meta = await channelMeta(parsed.ref); // no-ops without creds
      if (!opts?.name?.trim()) name = meta.name;
      thumb = meta.thumb;
    }
    return {
      kind: 'video',
      ref: parsed.ref,
      playlistId: '',
      name,
      playerKind: 'twitch',
      meta: { twitchKind: parsed.kind, thumbnailUrl: thumb },
    };
  },

  async fetchPage(source: ExternalSource): Promise<ProviderPage> {
    return { items: [toItem(source)], nextCursor: undefined };
  },

  async fetchVideo(source: ExternalSource): Promise<ProviderVideo> {
    return toItem(source);
  },
};
