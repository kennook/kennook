/**
 * The provider abstraction for external sources. Each public service (YouTube,
 * direct/HLS streams, RSS/podcasts, Internet Archive, Vimeo, Twitch, …) is a
 * plugin implementing `Provider`. The registry, category tree, grid, drag/reorder
 * and resume bar are all provider-agnostic — a provider only has to (a) claim a
 * URL, (b) resolve it into a stored source, and (c) fetch normalized video items.
 */

import type {
  ExternalProvider,
  ExternalSource,
  ExternalSourceKind,
  PlayerKind,
} from '@/server/external-sources';

/** Normalized grid + player item every provider produces. The first five fields
 *  match the legacy YouTube shape (the grid already consumes them); the rest let
 *  the client pick + drive the right player per item. */
export interface ProviderVideo {
  /** Stable id within the provider — used for embed players + de-dup keys. For
   *  native media with no natural id, the media URL is fine. */
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
  /** How to play THIS item (an RSS feed can mix youtube + native items). */
  playerKind: PlayerKind;
  /** Native/iframe playback URL (mp4 / mp3 / m3u8 / embed src). Omitted for
   *  embed players that play by id (youtube/vimeo/twitch). */
  mediaUrl?: string;
  /** Continuous live stream (no natural end → no auto-advance). */
  isLive?: boolean;
}

export interface ProviderPage {
  items: ProviderVideo[];
  nextCursor?: string;
}

/** What `resolve()` returns — everything the registry needs to store a source. */
export interface ResolvedSource {
  kind: ExternalSourceKind;
  ref: string;
  playlistId: string;
  name: string;
  playerKind: PlayerKind;
  meta?: Record<string, unknown>;
}

export interface Provider {
  id: ExternalProvider;
  /** Human label for the add dialog + errors. */
  label: string;
  /** Example URL shown as the add-dialog placeholder / hint. */
  urlHint: string;
  /** Does this provider claim the pasted URL? First match wins in the registry. */
  match(url: string): boolean;
  /** Parse + resolve a pasted URL into a storable source (may hit the network). */
  resolve(url: string, opts?: { name?: string }): Promise<ResolvedSource>;
  /** One page of a channel/playlist/feed source's items. */
  fetchPage(source: ExternalSource, cursor?: string): Promise<ProviderPage>;
  /** The single item for a `kind: 'video'` source (also used for category tiles). */
  fetchVideo(source: ExternalSource): Promise<ProviderVideo>;
}
