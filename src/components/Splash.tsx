import { KenNookLogo } from './KenNookLogo';

/**
 * Full-screen "please wait" splash. Used as the app's Suspense fallback so the
 * very first paint (SSR streams this while `useSearchParams` suspends, then it
 * holds until React hydrates) shows something branded and alive instead of a
 * blank page — which on a cold prod start can otherwise read as "frozen".
 *
 * Intentionally dependency-free and static (no hooks) so it renders instantly.
 */
export function Splash({ message = 'Starting up…' }: { message?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-zinc-950 text-zinc-400">
      <KenNookLogo height={40} />
      <div className="flex items-center gap-3 text-sm">
        <span
          aria-hidden
          className="inline-block w-4 h-4 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin"
        />
        <span>{message}</span>
      </div>
    </div>
  );
}
