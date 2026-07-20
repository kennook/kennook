/**
 * Top-left "dead corner" for chrome auto-hide. Pointer movement inside this
 * corner is IGNORED for the purpose of keeping the fullscreen viewer / video
 * controls alive — so parking the cursor here (e.g. under a mouse jiggler that
 * never stops nudging the pointer) still lets the controls fade out. Think of it
 * as a macOS hot-corner, but for "let the chrome disappear."
 */

/** Side length (px) of the square top-left dead corner. */
export const HIDE_CORNER_PX = 120;

/** True when a viewport pointer position sits in the top-left dead corner. */
export function inHideCorner(clientX: number, clientY: number): boolean {
  return clientX <= HIDE_CORNER_PX && clientY <= HIDE_CORNER_PX;
}
