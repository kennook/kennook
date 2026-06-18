import { router } from '@/server/trpc';
import { mediaRouter } from './media';
import { libraryRouter } from './library';
import { playlistRouter } from './playlist';
import { peopleRouter } from './people';
import { storageRouter } from './storage';
import { systemRouter } from './system';
import { savedSearchRouter } from './savedSearch';
import { screensaverLockRouter } from './screensaverLock';
import { usersRouter } from './users';
import { mediaViewRouter } from './mediaView';

export const appRouter = router({
  media: mediaRouter,
  library: libraryRouter,
  playlist: playlistRouter,
  people: peopleRouter,
  storage: storageRouter,
  system: systemRouter,
  savedSearch: savedSearchRouter,
  screensaverLock: screensaverLockRouter,
  users: usersRouter,
  mediaView: mediaViewRouter,
});

export type AppRouter = typeof appRouter;
