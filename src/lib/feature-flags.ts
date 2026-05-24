/**
 * Feature flags — toggle UI and functionality without code deletion.
 *
 * This module is the source of truth for what's enabled in the
 * current build. Values are hardcoded for now; the planned evolution
 * is in two stages:
 *
 *   1. Embedded admin UI in Kennook itself (planned). The admin will
 *      be able to flip flags for THIS instance via a settings page.
 *      Flag values move from this file to a config table in the
 *      user DB, with this file holding only the defaults / shape.
 *
 *   2. If Kennook ever becomes a hosted service, swap the backing
 *      store for a real flag provider — most likely GrowthBook
 *      (open-source, self-hostable, distribution-friendly: rules can
 *      be bundled with releases so installs don't need network calls
 *      to evaluate). Avoided commercial SaaS (LaunchDarkly etc.) on
 *      purpose — those bill per MAU and create a third-party
 *      dependency that hurts the self-hosted story.
 *
 * Both future stages preserve the FEATURES key set as the API; only
 * the source of values changes. So gate UI on `FEATURES.<flag>` and
 * the rename later is mechanical.
 */

export const FEATURES = {
  /**
   * Hold-to-record voice tagging in the media viewer. Parked on
   * 2026-05-23 — UX was creating more churn than the value justified.
   * The hook (`useVoiceTagger`), the `/api/voice-tag` route, the
   * Whisper + noun-extraction pipeline, the sidebar button, the
   * maxed-mode mic-icon button, and the V-key shortcut all remain
   * in place. Flip this to `true` to re-enable everything at once.
   */
  voiceTagging: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;
