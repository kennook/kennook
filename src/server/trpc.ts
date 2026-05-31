import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import {
  DEFAULT_LIBRARY_SLUG,
  parseLibraryCookie,
  resolveLibrary,
  type Library,
} from './libraries';

export interface Context {
  userId: number;
  library: Library;
  /** Per-tab id sent by the tRPC client. Used by mutations that publish
   *  sync events so the originating tab can skip its own echo on receipt. */
  sessionId: string | null;
}

export function createContext(opts: { req: Request }): Context {
  // URL-driven header wins over the cookie — each browser tab now carries
  // its library choice in `?lib=`, so flipping libraries in tab A no
  // longer leaks into tab B's next reload via the shared cookie. The
  // cookie stays as a fallback for first-load visitors who haven't been
  // through the URL state yet.
  //
  // Read both the new `x-kennook-library` header and the legacy
  // `x-kennook-workspace` for a smooth transition while older client
  // bundles may still be in caches.
  const headerSlug =
    opts.req.headers.get('x-kennook-library')
    ?? opts.req.headers.get('x-kennook-workspace');
  const cookieHeader = opts.req.headers.get('cookie');
  const slug = headerSlug || parseLibraryCookie(cookieHeader);
  const library = resolveLibrary(slug);
  return {
    userId: 1, // single-user v0.1
    library,
    sessionId: opts.req.headers.get('x-kennook-session'),
  };
}

export function createContextWithSlug(slug: string = DEFAULT_LIBRARY_SLUG): Context {
  return { userId: 1, library: resolveLibrary(slug), sessionId: null };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
