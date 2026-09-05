import { z } from 'zod';
import { router, adminProcedure } from '@/server/trpc';
import {
  listScreensavers,
  removeScreensaver,
  setScreensaverEnabled,
  setOnlyScreensaver,
} from '@/server/screensavers';

/**
 * Admin management of custom screensaver clips. Uploading is a plain route
 * handler (/api/admin/screensaver/upload — tRPC can't carry file bodies); this
 * router covers listing (with transcode status) and deletion. All admin-only —
 * a Viewer shouldn't be able to change what plays on the wall.
 */
export const screensaverRouter = router({
  /** Every custom clip with its status, newest first. The admin card polls this
   *  while any clip is still `processing`. */
  list: adminProcedure.query(() => listScreensavers()),

  /** Enable/disable a clip — only enabled + ready clips are in the rotation. */
  setEnabled: adminProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => { setScreensaverEnabled(input.id, input.enabled); return { ok: true }; }),

  /** Enable only this clip, disabling every other — a one-click "solo". */
  setOnly: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => { setOnlyScreensaver(input.id); return { ok: true }; }),

  /** Delete a clip (registry entry + its files). Idempotent. */
  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => ({ removed: removeScreensaver(input.id) })),
});
