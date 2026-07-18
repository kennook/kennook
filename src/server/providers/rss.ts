/**
 * RSS / Atom / MRSS provider — no token. Handles podcast feeds (audio + video
 * enclosures), Media-RSS video feeds, and YouTube channel RSS
 * (youtube.com/feeds/videos.xml?channel_id=… — no API key). A feed is stored as
 * a playlist source; each entry is normalized to a ProviderVideo, and its
 * playerKind is per-item (podcast enclosure → native; YouTube RSS → youtube).
 */

import { XMLParser } from 'fast-xml-parser';
import type { ExternalSource } from '@/server/external-sources';
import type { Provider, ProviderVideo, ProviderPage } from './types';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: false });

function txt(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text'] ?? '');
  return String(v);
}
function arr<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}
function attr(v: unknown, name: string): string {
  if (v && typeof v === 'object') return String((v as Record<string, unknown>)[name] ?? '');
  return '';
}

async function fetchFeed(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { 'user-agent': 'KenNook/1.0 (+external-sources)' } });
  if (!res.ok) throw new Error(`Feed fetch failed (${res.status}).`);
  const xml = await res.text();
  const doc = parser.parse(xml) as Record<string, unknown>;
  if (!doc || (!doc.rss && !doc.feed)) throw new Error('Not a valid RSS/Atom feed.');
  return doc;
}

interface ParsedFeed { title: string; image: string; items: ProviderVideo[] }

function parseFeed(doc: Record<string, unknown>): ParsedFeed {
  // ── Atom (incl. YouTube RSS) ──
  if (doc.feed) {
    const feed = doc.feed as Record<string, unknown>;
    const title = txt(feed.title) || 'Feed';
    const items: ProviderVideo[] = arr(feed.entry as unknown[]).map((e): ProviderVideo | null => {
      const entry = e as Record<string, unknown>;
      const ytId = txt(entry['yt:videoId']);
      const group = entry['media:group'] as Record<string, unknown> | undefined;
      const thumb = attr(group?.['media:thumbnail'], '@_url')
        || attr(arr(entry['media:thumbnail'] as unknown[])[0], '@_url');
      const published = txt(entry.published) || txt(entry.updated);
      if (ytId) {
        return {
          videoId: ytId, title: txt(entry.title), thumbnailUrl: thumb,
          channelTitle: title, publishedAt: published, playerKind: 'youtube' as const,
        };
      }
      // Generic Atom: look for an enclosure link.
      const link = arr(entry.link as unknown[]).find((l) => attr(l, '@_rel') === 'enclosure');
      const href = attr(link, '@_href');
      return href ? {
        videoId: href, title: txt(entry.title), thumbnailUrl: thumb,
        channelTitle: title, publishedAt: published, playerKind: 'native' as const, mediaUrl: href,
      } : null;
    }).filter((x): x is ProviderVideo => x != null);
    return { title, image: '', items };
  }

  // ── RSS 2.0 (podcasts / MRSS) ──
  const rss = doc.rss as Record<string, unknown>;
  const channel = (rss?.channel ?? {}) as Record<string, unknown>;
  const title = txt(channel.title) || 'Feed';
  const channelImg = attr(channel['itunes:image'], '@_href') || txt((channel.image as Record<string, unknown>)?.url);
  const items: ProviderVideo[] = arr(channel.item as unknown[]).map((it): ProviderVideo | null => {
    const item = it as Record<string, unknown>;
    const enclosure = arr(item.enclosure as unknown[])[0];
    const mediaContent = arr(item['media:content'] as unknown[])[0];
    const url = attr(enclosure, '@_url') || attr(mediaContent, '@_url');
    if (!url) return null;
    const thumb = attr(item['itunes:image'], '@_href')
      || attr(arr(item['media:thumbnail'] as unknown[])[0], '@_url')
      || channelImg;
    return {
      videoId: txt(item.guid) || url,
      title: txt(item.title),
      thumbnailUrl: thumb,
      channelTitle: title,
      publishedAt: txt(item.pubDate),
      playerKind: 'native' as const,
      mediaUrl: url,
    };
  }).filter((x): x is ProviderVideo => x != null);
  return { title, image: channelImg, items };
}

export const rssProvider: Provider = {
  id: 'rss',
  label: 'RSS / podcast',
  urlHint: 'https://…/feed.xml  or a podcast feed',

  match(url) {
    const u = url.trim().toLowerCase();
    if (u.includes('feeds/videos.xml')) return true; // YouTube channel RSS
    return /\.(xml|rss|atom)(\?|#|$)/.test(u) || /(^|\/\/|\.)(feeds?|rss)\b/.test(u) || /\/feed\/?($|\?)/.test(u);
  },

  async resolve(url, opts) {
    const doc = await fetchFeed(url.trim());
    const feed = parseFeed(doc);
    return {
      kind: 'playlist',
      ref: url.trim(),
      playlistId: url.trim(),
      name: (opts?.name?.trim()) || feed.title,
      playerKind: 'native',
      meta: { feedUrl: url.trim() },
    };
  },

  async fetchPage(source: ExternalSource): Promise<ProviderPage> {
    const doc = await fetchFeed(String(source.meta?.feedUrl ?? source.playlistId));
    return { items: parseFeed(doc).items, nextCursor: undefined };
  },

  async fetchVideo(source: ExternalSource): Promise<ProviderVideo> {
    const doc = await fetchFeed(String(source.meta?.feedUrl ?? source.ref));
    const first = parseFeed(doc).items[0];
    if (!first) throw new Error('Feed has no playable items.');
    return first;
  },
};
