/**
 * Direct / HLS stream provider — no token. Claims a bare media URL (a live HLS
 * m3u8, a progressive mp4/webm, or an audio stream mp3/aac/ogg) and stores it as
 * a single-item "live channel" source that plays in the native player. Perfect
 * for the live-channel / ambient-screensaver use case.
 *
 * A raw URL has no fetchable title, so the add dialog's optional Name is used
 * (falling back to the filename).
 */

import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo } from './types';

const MEDIA_EXT = /\.(m3u8|mpd|mp4|webm|mov|m4v|mp3|aac|ogg|oga|m4a|flac|wav)(\?|#|$)/i;

function isHls(url: string): boolean {
  return /\.(m3u8)(\?|#|$)/i.test(url) || /\.(mpd)(\?|#|$)/i.test(url);
}

function filenameFrom(url: string): string {
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split('/').filter(Boolean).pop() ?? '');
    return last.replace(/\.[a-z0-9]+$/i, '') || 'Stream';
  } catch { return 'Stream'; }
}

function toItem(source: ExternalSource): ProviderVideo {
  const url = String(source.meta?.mediaUrl ?? source.ref);
  return {
    videoId: url,
    title: source.name,
    thumbnailUrl: '',
    channelTitle: '',
    publishedAt: '',
    playerKind: 'native',
    mediaUrl: url,
    isLive: Boolean(source.meta?.isLive),
  };
}

export const streamProvider: Provider = {
  id: 'stream',
  label: 'Stream / media URL',
  urlHint: 'https://…/live.m3u8  or  …/clip.mp4',

  match(url) {
    return MEDIA_EXT.test(url.trim());
  },

  async resolve(url, opts) {
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean)) throw new Error('Enter a full http(s) media URL.');
    const live = isHls(clean);
    return {
      kind: 'video',
      ref: clean,
      playlistId: '',
      name: (opts?.name?.trim()) || filenameFrom(clean),
      playerKind: 'native',
      meta: { mediaUrl: clean, isLive: live },
    };
  },

  async fetchPage(source) {
    return { items: [toItem(source)], nextCursor: undefined };
  },

  async fetchVideo(source) {
    return toItem(source);
  },
};
