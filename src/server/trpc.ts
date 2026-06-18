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
  isAdmin as userIsAdmin,
  isAuthenticated,
  isAuthGateEnabled,
} from './auth';

export interface Context {
  userId: number;
  library: Library;
  /** Per-tab id sent by the tRPC client. Used by mutations that publish
   *  sync events so the originating tab can skip its own echo on receipt. */
  sessionId: string | null;
  /** Whether the caller's `kennook_user` cookie resolves to an admin.
   *  Cookie-only (Phase 0 auth) — gates write procedures like setting the
   *  screensaver lock; replaced wholesale when real AuthN lands. */
  isAdmin: boolean;
  /** Whether the caller carries a valid signed session (vs. anonymous). */
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
  let authed = false;
  try { admin = userIsAdmin(getCurrentUser(cookieHeader)); } catch { admin = false; }
  try { authed = isAuthenticated(cookieHeader); } catch { authed = false; }
  return {
    userId: 1, // single-user v0.1
    library,
    sessionId: opts.req.headers.get('x-kennook-session'),
    isAdmin: admin,
    authenticated: authed,
  };
}

export function createContextWithSlug(slug: string = DEFAULT_LIBRARY_SLUG): Context {
  return {
    userId: 1,
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

// When the app-wide login gate is on (the default Viewer has a password),
// every data procedure requires a valid signed session — otherwise an
// unauthenticated client could read the library by hitting /api/trpc
// directly, even though the page itself redirects to /login. Gate-off
// instances are unaffected (open, as before).
const enforceAuthGate = t.middleware(({ ctx, next }) => {
  if (!ctx.authenticated && isAuthGateEnabled()) {
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
