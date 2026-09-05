import { z } from 'zod';
import { router, publicProcedure, adminProcedure } from '@/server/trpc';
import { getScreensaverRotateMs, setScreensaverRotateMs } from '@/server/app-config';
import {
  listScreensavers,
  removeScreensaver,
  setScreensaverEnabled,
  setScreensaverLoop,
  setScreensaverSpeed,
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

  /** Toggle the seamless (boomerang) loop — builds a reversed-tail variant. */
  setLoop: adminProcedure
    .input(z.object({ id: z.string(), loop: z.boolean() }))
    .mutation(({ input }) => { setScreensaverLoop(input.id, input.loop); return { ok: true }; }),

  /** Set the playback speed (0.5/1/2/3×) — applied client-side, no re-encode. */
  setSpeed: adminProcedure
    .input(z.object({ id: z.string(), speed: z.number() }))
    .mutation(({ input }) => { setScreensaverSpeed(input.id, input.speed); return { ok: true }; }),

  /** Auto-rotate interval (ms; 0 = off) — how often the screensaver advances to
   *  the next active clip. Public read (the screensaver needs it); admin write. */
  rotate: publicProcedure.query(() => ({ ms: getScreensaverRotateMs() })),
  setRotate: adminProcedure
    .input(z.object({ ms: z.number().int().min(0) }))
    .mutation(({ input }) => { setScreensaverRotateMs(input.ms); return { ok: true }; }),

  /** Delete a clip (registry entry + its files). Idempotent. */
  remove: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => ({ removed: removeScreensaver(input.id) })),
});
