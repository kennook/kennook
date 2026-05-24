import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import {
  DEFAULT_WORKSPACE_SLUG,
  parseWorkspaceCookie,
  resolveWorkspace,
  type Workspace,
} from './workspaces';

export interface Context {
  userId: number;
  workspace: Workspace;
  /** Per-tab id sent by the tRPC client. Used by mutations that publish
   *  sync events so the originating tab can skip its own echo on receipt. */
  sessionId: string | null;
}

export function createContext(opts: { req: Request }): Context {
  // URL-driven header wins over the cookie — each browser tab now carries
  // its workspace choice in `?ws=`, so flipping workspaces in tab A no
  // longer leaks into tab B's next reload via the shared cookie. The
  // cookie stays as a fallback for first-load visitors who haven't been
  // through the URL state yet.
  const headerSlug = opts.req.headers.get('x-kennook-workspace');
  const cookieHeader = opts.req.headers.get('cookie');
  const slug = headerSlug || parseWorkspaceCookie(cookieHeader);
  const workspace = resolveWorkspace(slug);
  return {
    userId: 1, // single-user v0.1
    workspace,
    sessionId: opts.req.headers.get('x-kennook-session'),
  };
}

export function createContextWithSlug(slug: string = DEFAULT_WORKSPACE_SLUG): Context {
  return { userId: 1, workspace: resolveWorkspace(slug), sessionId: null };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
