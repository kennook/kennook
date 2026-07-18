/**
 * YouTube provider — wraps the existing key-only Data API client (server/youtube.ts)
 * in the Provider interface. Behavior is unchanged from before the framework:
 * channels page through their uploads playlist, playlists page directly, a video
 * link is a single-item source.
 */

import type { ExternalSource } from '@/server/external-sources';
import {
  parseYouTubeUrl,
  resolveYouTubeSource,
  fetchPlaylistPage,
  fetchVideoAsItem,
  type YouTubeVideo,
} from '@/server/youtube';
import type { Provider, ProviderVideo } from './types';

function toItem(v: YouTubeVideo): ProviderVideo {
  return { ...v, playerKind: 'youtube' };
}

export const youtubeProvider: Provider = {
  id: 'youtube',
  label: 'YouTube',
  urlHint: 'https://www.youtube.com/@channel',

  match(url) {
    return parseYouTubeUrl(url) != null;
  },

  async resolve(url) {
    const parsed = parseYouTubeUrl(url);
    if (!parsed) throw new Error('Not a recognized YouTube URL. Paste a channel, playlist, or video link.');
    const r = await resolveYouTubeSource(parsed);
    return { ...r, playerKind: 'youtube' };
  },

  async fetchPage(source: ExternalSource, cursor?: string) {
    const page = await fetchPlaylistPage(source.playlistId, cursor);
    return { items: page.items.map(toItem), nextCursor: page.nextCursor };
  },

  async fetchVideo(source: ExternalSource) {
    return toItem(await fetchVideoAsItem(source.ref));
  },
};
