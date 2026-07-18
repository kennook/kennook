/**
 * Vimeo provider. A single video needs NO token — resolved via Vimeo's public
 * oEmbed endpoint. Channels / showcases need a single app token
 * (VIMEO_ACCESS_TOKEN); without it we surface a clear error. Plays via the Vimeo
 * Player SDK (playerKind 'vimeo').
 */

import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo, ProviderPage } from './types';

function videoIdFromUrl(url: string): string | null {
  const m = url.trim().match(/vimeo\.com\/(?:video\/)?(\d+)/i)
    ?? url.trim().match(/player\.vimeo\.com\/video\/(\d+)/i);
  return m ? m[1] : null;
}

interface OEmbed { title?: string; thumbnail_url?: string; author_name?: string; video_id?: number }

async function oembed(videoId: string): Promise<OEmbed> {
  const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${videoId}`)}`);
  if (!res.ok) throw new Error(`Vimeo video ${videoId} not found (${res.status}).`);
  return res.json() as Promise<OEmbed>;
}

function toItem(videoId: string, o: OEmbed): ProviderVideo {
  return {
    videoId,
    title: o.title ?? `Vimeo ${videoId}`,
    thumbnailUrl: o.thumbnail_url ?? '',
    channelTitle: o.author_name ?? '',
    publishedAt: '',
    playerKind: 'vimeo',
  };
}

export const vimeoProvider: Provider = {
  id: 'vimeo',
  label: 'Vimeo',
  urlHint: 'https://vimeo.com/<id>',

  match(url) {
    try { return new URL(url.trim()).hostname.endsWith('vimeo.com'); } catch { return false; }
  },

  async resolve(url, opts) {
    const id = videoIdFromUrl(url);
    if (!id) {
      // A channel/showcase link — needs the API token.
      if (!process.env.VIMEO_ACCESS_TOKEN) {
        throw new Error('Vimeo channels/showcases need VIMEO_ACCESS_TOKEN set. A single video link (vimeo.com/<id>) works without it.');
      }
      throw new Error('Vimeo channels/showcases are not supported yet — add individual videos for now.');
    }
    const o = await oembed(id);
    return {
      kind: 'video',
      ref: id,
      playlistId: '',
      name: (opts?.name?.trim()) || o.title || `Vimeo ${id}`,
      playerKind: 'vimeo',
      meta: { thumbnailUrl: o.thumbnail_url ?? '', author: o.author_name ?? '' },
    };
  },

  async fetchPage(source: ExternalSource): Promise<ProviderPage> {
    return { items: [await this.fetchVideo(source)], nextCursor: undefined };
  },

  async fetchVideo(source: ExternalSource): Promise<ProviderVideo> {
    // Prefer the cached oEmbed metadata; refetch only if missing.
    const cachedThumb = source.meta?.thumbnailUrl;
    if (typeof cachedThumb === 'string') {
      return {
        videoId: source.ref, title: source.name, thumbnailUrl: cachedThumb,
        channelTitle: String(source.meta?.author ?? ''), publishedAt: '', playerKind: 'vimeo',
      };
    }
    return toItem(source.ref, await oembed(source.ref));
  },
};
