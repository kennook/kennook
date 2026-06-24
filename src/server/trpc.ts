import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import {
  DEFAULT_LIBRARY_SLUG,
  parseLibraryCookie,
  resolveLibrary,
  type Library,
} from './libraries';
import {
  getCurrentUser,
  getSession,
  isAdmin as userIsAdmin,
  SHARED_DATA_USER_ID,
} from './auth';

export interface Context {
  /** The signed-in user — drives PERSONAL data (likes, views, playlists,
   *  saved searches). Anonymous visitors resolve to the Viewer id. */
  userId: number;
  /** Owner of SHARED content (media, people, faces) — the operator's library,
   *  the same for every user. Use this (not userId) for those queries. */
  sharedUserId: number;
  library: Library;
  /** Per-tab id sent by the tRPC client. Used by mutations that publish
   *  sync events so the originating tab can skip its own echo on receipt. */
  sessionId: string | null;
  /** Whether the caller's `kennook_user` cookie resolves to an admin. */
  isAdmin: boolean;
  /** Whether the caller carries a valid signed session. "Continue anonymously"
   *  also produces a signed session, so anonymous users are authenticated. */
  authenticated: boolean;
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
  // Defensive: a DB hiccup resolving the role must never 500 every request —
  // degrade to non-admin (the safe default for write gating).
  let admin = false;
  let session = { userId: SHARED_DATA_USER_ID, authenticated: false };
  try { admin = userIsAdmin(getCurrentUser(cookieHeader)); } catch { admin = false; }
  try { session = getSession(cookieHeader); } catch { /* keep anonymous default */ }
  return {
    userId: session.userId,
    sharedUserId: SHARED_DATA_USER_ID,
    library,
    sessionId: opts.req.headers.get('x-kennook-session'),
    isAdmin: admin,
    authenticated: session.authenticated,
  };
}

export function createContextWithSlug(slug: string = DEFAULT_LIBRARY_SLUG): Context {
  return {
    userId: SHARED_DATA_USER_ID,
    sharedUserId: SHARED_DATA_USER_ID,
    library: resolveLibrary(slug),
    sessionId: null,
    isAdmin: false,
    authenticated: false,
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;

// Every data procedure requires a signed session. Visitors choose at /login:
// sign in to a named account, or "Continue anonymously" (which still mints a
// signed session as the shared Viewer). So an unauthenticated caller hitting
// /api/trpc directly is rejected, matching the page-level redirect.
const enforceAuthGate = t.middleware(({ ctx, next }) => {
  if (!ctx.authenticated) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required.' });
  }
  return next();
});

export const publicProcedure = t.procedure.use(enforceAuthGate);

/** Write procedures restricted to the admin role (cookie-derived). */
export const adminProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin role required.' });
  }
  return next();
});
