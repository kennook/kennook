'use client';

import { useState } from 'react';
import { useSyncEvent } from '@/lib/sync';
import { KENNOOK_VERSION, KENNOOK_BUILD_ID } from '@/lib/version';
import { classifyBump } from '@/lib/semver';

/**
 * Watches the `server-version` sync event (delivered on every SSE connect /
 * reconnect) and, when the live server process is running a different build
 * than the one this tab loaded, prompts a reload.
 *
 *   • patch bump or same-semver rebuild → DISMISSABLE ("recommended")
 *   • minor / major bump                → NON-DISMISSABLE ("required")
 *
 * The comparison is against this bundle's BAKED version/buildId (src/lib/
 * version.ts), so it reflects what the user is actually running — once the
 * server restarts onto a new build, EventSource reconnects, the new version
 * arrives, and the banner appears. Mounted app-wide from the provider tree so
 * it covers the main app, /admin, and mobile.
 */

const DISMISS_KEY = 'kennook.reloadDismissed';

function dismissedKey(version: string, buildId: string): string {
  return `${version}+${buildId}`;
}

function isDismissed(version: string, buildId: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === dismissedKey(version, buildId);
  } catch {
    return false;
  }
}

interface Prompt {
  severity: 'required' | 'recommended';
  version: string;
  buildId: string;
}

export function ReloadPrompt() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  useSyncEvent('server-version', (e) => {
    // Identical to what this tab loaded against → nothing to do. We check BOTH
    // version and buildId: the buildId (git sha) can be unchanged across a
    // same-commit version bump, so a version difference must still prompt; and
    // version can be unchanged across a rebuild at a different commit, so a
    // buildId difference must still prompt.
    if (e.version === KENNOOK_VERSION && e.buildId === KENNOOK_BUILD_ID) {
      setPrompt(null);
      return;
    }
    const bump = classifyBump(KENNOOK_VERSION, e.version);
    const severity = bump === 'major' || bump === 'minor' ? 'required' : 'recommended';
    // A dismissed "recommended" prompt for this exact build stays hidden; a
    // later, different build re-shows it (different key).
    if (severity === 'recommended' && isDismissed(e.version, e.buildId)) {
      setPrompt(null);
      return;
    }
    setPrompt({ severity, version: e.version, buildId: e.buildId });
  });

  if (!prompt) return null;

  const required = prompt.severity === 'required';

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, dismissedKey(prompt.version, prompt.buildId)); }
    catch { /* private mode / disabled — banner just reappears next event */ }
    setPrompt(null);
  };

  return (
    <div
      // Above the viewer (z-50) and screensaver (z-100): a required reload
      // shouldn't be hidden behind anything. Centered at top, non-blocking
      // except for its own controls.
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw]
                 pointer-events-none flex justify-center"
      role={required ? 'alertdialog' : 'status'}
      aria-live={required ? 'assertive' : 'polite'}
    >
      <div
        className={`pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-2.5
                    text-sm shadow-lg ring-1 backdrop-blur
                    ${required
                      ? 'bg-red-950/90 ring-red-800/70 text-red-100'
                      : 'bg-amber-950/90 ring-amber-800/70 text-amber-100'}`}
      >
        <span className="flex-1 min-w-0">
          {required ? (
            <><strong className="font-semibold">Reload required.</strong>{' '}
              A new version (v{prompt.version}) is running — reload to continue.</>
          ) : (
            <><strong className="font-semibold">New version available</strong>{' '}
              (v{prompt.version}). Reload when convenient to update.</>
          )}
        </span>

        <button
          onClick={() => window.location.reload()}
          className={`shrink-0 rounded-md px-3 py-1 font-medium transition
                      ${required
                        ? 'bg-red-600 hover:bg-red-500 text-white'
                        : 'bg-amber-600 hover:bg-amber-500 text-white'}`}
        >
          Reload
        </button>

        {!required && (
          <button
            onClick={dismiss}
            className="shrink-0 text-amber-300/80 hover:text-amber-100 transition"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
