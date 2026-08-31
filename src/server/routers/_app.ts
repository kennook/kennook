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
import { configRouter } from './config';
import { externalSourceRouter } from './externalSource';
import { hotCornersRouter } from './hotCorners';
import { shortcutsRouter } from './shortcuts';

export const appRouter = router({
  media: mediaRouter,
  library: libraryRouter,
  externalSource: externalSourceRouter,
  playlist: playlistRouter,
  people: peopleRouter,
  storage: storageRouter,
  system: systemRouter,
  savedSearch: savedSearchRouter,
  screensaverLock: screensaverLockRouter,
  users: usersRouter,
  mediaView: mediaViewRouter,
  config: configRouter,
  hotCorners: hotCornersRouter,
  shortcuts: shortcutsRouter,
});

export type AppRouter = typeof appRouter;
