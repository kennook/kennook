/**
 * Provider registry. Add a provider here and it's available everywhere — the
 * router dispatches by `source.provider`, and `detectProvider` claims a pasted
 * URL (first match wins, so order = precedence). Everything else (categories,
 * grid, drag/reorder) is already provider-agnostic.
 */

import type { ExternalProvider } from '@/server/external-sources';
import type { Provider } from './types';
import { youtubeProvider } from './youtube';

// Order matters: a URL is claimed by the FIRST provider whose match() is true.
// Specific providers (youtube, vimeo, twitch, archive, rss) should precede the
// catch-all `stream` (which claims bare media/stream URLs).
const PROVIDERS: Provider[] = [
  youtubeProvider,
  // stream / rss / archive / vimeo / twitch appended in later phases.
];

const BY_ID = new Map<string, Provider>(PROVIDERS.map((p) => [p.id, p]));

/** The provider that owns a stored source, by its `provider` field (or an
 *  explicit override id). Throws on an unknown id. */
export function getProvider(id: string): Provider {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`No provider registered for "${id}".`);
  return p;
}

/** The first provider that claims a pasted URL, or null if none recognize it. */
export function detectProvider(url: string): Provider | null {
  for (const p of PROVIDERS) {
    try { if (p.match(url)) return p; } catch { /* a bad matcher shouldn't block others */ }
  }
  return null;
}

/** Lightweight list for the add dialog (id + label + example URL). */
export function listProviders(): Array<{ id: ExternalProvider; label: string; urlHint: string }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, urlHint: p.urlHint }));
}
