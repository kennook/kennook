import { router } from '@/server/trpc';
import { mediaRouter } from './media';
import { workspaceRouter } from './workspace';
import { playlistRouter } from './playlist';
import { peopleRouter } from './people';

export const appRouter = router({
  media: mediaRouter,
  workspace: workspaceRouter,
  playlist: playlistRouter,
  people: peopleRouter,
});

export type AppRouter = typeof appRouter;
