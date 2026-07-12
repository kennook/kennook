/**
 * Minimal YouTube Data API v3 client for external sources — parse a channel/
 * playlist URL, resolve it to a pageable playlist, and fetch video pages.
 *
 * Key-only (no OAuth): reads YOUTUBE_API_KEY from the environment. Only public
 * channels/playlists are reachable. If the key is missing, calls throw a clear
 * error the UI surfaces.
 */

const API = 'https://www.googleapis.com/youtube/v3';

function apiKey(): string {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) {
    throw new Error(
      'YOUTUBE_API_KEY is not set. Create a YouTube Data API v3 key in Google Cloud Console and add it to .env.local.',
    );
  }
  return k;
}

async function yt<T = Record<string, unknown>>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey());
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `${res.status}`;
    try { msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep status */ }
    throw new Error(`YouTube API (${endpoint}) failed: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export interface ParsedYouTube {
  kind: 'channel' | 'playlist' | 'video';
  /** channelId (UC…), a handle (@name), a playlistId, or a videoId. */
  ref: string;
}

/** Parse a YouTube channel / playlist / video URL. Returns null if it isn't
 *  a recognizable YouTube link. A video resolves to its channel (see
 *  resolveYouTubeSource). */
export function parseYouTubeUrl(raw: string): ParsedYouTube | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;

  // A playlist link (list=…) wins regardless of host / a video also being present.
  const list = u.searchParams.get('list');
  if (list) return { kind: 'playlist', ref: list };

  // Short video link: youtu.be/<id>
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { kind: 'video', ref: id } : null;
  }

  // youtube.com/watch?v=<id>
  const v = u.searchParams.get('v');
  if (v && u.pathname === '/watch') return { kind: 'video', ref: v };

  const p = u.pathname;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/channel\/(UC[\w-]+)/))) return { kind: 'channel', ref: m[1] };
  // Video paths: /shorts/<id>, /live/<id> (live stream), /embed/<id>, /v/<id>.
  if ((m = p.match(/^\/(?:shorts|live|embed|v)\/([\w-]+)/))) return { kind: 'video', ref: m[1] };
  if ((m = p.match(/^\/@([\w.-]+)/))) return { kind: 'channel', ref: `@${m[1]}` };
  return null;
}

interface ChannelMeta { channelId: string; title: string; uploadsPlaylistId: string; }

/** Resolve a channel ref (UC… id OR @handle) to its metadata + uploads playlist. */
async function fetchChannelMeta(ref: string): Promise<ChannelMeta> {
  const params: Record<string, string> = { part: 'snippet,contentDetails' };
  if (ref.startsWith('@')) params.forHandle = ref.slice(1);
  else params.id = ref;
  const data = await yt<{ items?: Array<{ id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>('channels', params);
  const item = data.items?.[0];
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!item || !uploads) throw new Error(`YouTube channel not found for "${ref}".`);
  return { channelId: item.id, title: item.snippet?.title ?? ref, uploadsPlaylistId: uploads };
}

async function fetchPlaylistTitle(playlistId: string): Promise<string> {
  const data = await yt<{ items?: Array<{ snippet?: { title?: string } }> }>('playlists', { part: 'snippet', id: playlistId });
  const t = data.items?.[0]?.snippet?.title;
  if (!t) throw new Error(`YouTube playlist not found for "${playlistId}".`);
  return t;
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
}
export interface YouTubePage { items: YouTubeVideo[]; nextCursor?: string; }

/** Fetch a single video's snippet as an item (for single-video/live sources). */
export async function fetchVideoAsItem(videoId: string): Promise<YouTubeVideo> {
  const data = await yt<{ items?: Array<{ snippet?: {
    title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }>;
  } }> }>('videos', { part: 'snippet', id: videoId });
  const sn = data.items?.[0]?.snippet;
  if (!sn) throw new Error(`YouTube video not found for "${videoId}".`);
  const th = sn.thumbnails ?? {};
  const thumb = (th.medium ?? th.high ?? th.standard ?? th.default ?? {}).url ?? '';
  return {
    videoId,
    title: sn.title ?? '',
    thumbnailUrl: thumb,
    channelTitle: sn.channelTitle ?? '',
    publishedAt: sn.publishedAt ?? '',
  };
}

export interface ResolvedYouTubeSource {
  kind: 'channel' | 'playlist' | 'video';
  ref: string;        // channelId, playlistId, or videoId
  playlistId: string; // pageable playlist ('' for a single video)
  name: string;       // channel/playlist/video title
}

/** Turn a parsed URL into everything the registry needs to store. A video/live
 *  link becomes a single-video source (just that stream/clip); channel and
 *  playlist links become channel/playlist sources. */
export async function resolveYouTubeSource(parsed: ParsedYouTube): Promise<ResolvedYouTubeSource> {
  if (parsed.kind === 'playlist') {
    const name = await fetchPlaylistTitle(parsed.ref);
    return { kind: 'playlist', ref: parsed.ref, playlistId: parsed.ref, name };
  }
  if (parsed.kind === 'video') {
    const v = await fetchVideoAsItem(parsed.ref);
    return { kind: 'video', ref: parsed.ref, playlistId: '', name: v.title };
  }
  const meta = await fetchChannelMeta(parsed.ref);
  return { kind: 'channel', ref: meta.channelId, playlistId: meta.uploadsPlaylistId, name: meta.title };
}

/** One page (up to 50) of a playlist's videos. `cursor` is the page token. */
export async function fetchPlaylistPage(playlistId: string, cursor?: string): Promise<YouTubePage> {
  const params: Record<string, string> = { part: 'snippet,contentDetails', maxResults: '50', playlistId };
  if (cursor) params.pageToken = cursor;
  const data = await yt<{
    nextPageToken?: string;
    items?: Array<{
      contentDetails?: { videoId?: string; videoPublishedAt?: string };
      snippet?: {
        title?: string; channelTitle?: string; videoOwnerChannelTitle?: string; publishedAt?: string;
        thumbnails?: Record<string, { url?: string }>;
      };
    }>;
  }>('playlistItems', params);

  const items: YouTubeVideo[] = (data.items ?? []).map((it) => {
    const sn = it.snippet ?? {};
    const th = sn.thumbnails ?? {};
    const thumb = (th.medium ?? th.high ?? th.standard ?? th.default ?? {}).url ?? '';
    return {
      videoId: it.contentDetails?.videoId ?? '',
      title: sn.title ?? '',
      thumbnailUrl: thumb,
      channelTitle: sn.videoOwnerChannelTitle ?? sn.channelTitle ?? '',
      publishedAt: it.contentDetails?.videoPublishedAt ?? sn.publishedAt ?? '',
    };
  }).filter((v) => v.videoId && v.title !== 'Private video' && v.title !== 'Deleted video');

  return { items, nextCursor: data.nextPageToken };
}
