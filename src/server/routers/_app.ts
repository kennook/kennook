import { router } from '@/server/trpc';
import { mediaRouter } from './media';
import { libraryRouter } from './library';
import { playlistRouter } from './playlist';
import { peopleRouter } from './people';
import { storageRouter } from './storage';

export const appRouter = router({
  media: mediaRouter,
  library: libraryRouter,
  playlist: playlistRouter,
  people: peopleRouter,
  storage: storageRouter,
});

export type AppRouter = typeof appRouter;
