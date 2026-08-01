'use client';

/**
 * A single app-wide custom tooltip, mounted once at the root. Replaces the slow,
 * tiny native `title` tooltip with a fast, legible, scale-aware one — without
 * wrapping every control or pulling in a tooltip library.
 *
 * How it stays zero-churn: a delegated listener reads the hovered element's
 * `data-tooltip` (explicit) or its existing `title` (fallback). For `title`, it
 * strips the attribute so the browser's native tooltip never fires, then renders
 * our own. That's safe with React because React only writes a DOM attribute when
 * its VALUE changes between renders (it diffs props, not the live DOM) — so a
 * re-render with the same title won't re-add the stripped attribute. The title is
 * restored when the pointer leaves, so accessibility tooling still sees it (most
 * controls also carry an aria-label).
 *
 * Sizing tracks --kn-chrome-scale (see .kn-tooltip in globals.css) so it grows
 * with the rest of the chrome on large displays.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 300;   // first appearance — snappier than the native ~1s
const RESHOW_GRACE_MS = 250; // moving between controls re-shows near-instantly
const GAP = 8;               // px between the control and the tooltip
const EDGE = 6;              // min px from the viewport edge

export function TooltipLayer() {
  const [state, setState] = useState<{ target: HTMLElement; label: string } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const timer = useRef(0);
  const activeEl = useRef<HTMLElement | null>(null);
  const strippedTitle = useRef<string | null>(null);
  const visible = useRef(false);
  const hideAt = useRef(0);

  useEffect(() => {
    // Put the native `title` back on whatever element we stripped it from.
    const restoreTitle = () => {
      const el = activeEl.current;
      if (el && strippedTitle.current != null) el.setAttribute('title', strippedTitle.current);
      strippedTitle.current = null;
    };

    const hide = () => {
      window.clearTimeout(timer.current);
      restoreTitle();
      activeEl.current = null;
      if (visible.current) { visible.current = false; hideAt.current = performance.now(); }
      setState(null);
      setPos(null);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tooltip],[title]') as HTMLElement | null;
      if (!el || el === activeEl.current) return;
      // Switching targets — tidy up the previous one first.
      if (activeEl.current) { window.clearTimeout(timer.current); restoreTitle(); }

      const label = (el.getAttribute('data-tooltip') ?? el.getAttribute('title') ?? '').trim();
      if (!label) { activeEl.current = null; return; }
      activeEl.current = el;

      // Suppress the native tooltip by removing `title` while we own it.
      if (el.hasAttribute('title')) {
        strippedTitle.current = el.getAttribute('title');
        el.removeAttribute('title');
      } else {
        strippedTitle.current = null;
      }

      const now = performance.now();
      const delay = visible.current || now - hideAt.current < RESHOW_GRACE_MS ? 0 : SHOW_DELAY_MS;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        visible.current = true;
        setState({ target: el, label });
      }, delay);
    };

    const onOut = (e: MouseEvent) => {
      if (!activeEl.current) return;
      const to = e.relatedTarget as Node | null;
      if (to && activeEl.current.contains(to)) return; // moving within the same control
      const from = e.target as Node | null;
      if (from && (activeEl.current === from || activeEl.current.contains(from))) hide();
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousedown', hide, true); // a click dismisses immediately
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer.current);
      restoreTitle();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  // Position after render, once we can measure the tooltip. Below the control by
  // default; flips above when there's no room; clamped horizontally. Runs before
  // paint (useLayoutEffect), so the tooltip never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!state || !tipRef.current) return;
    const r = state.target.getBoundingClientRect();
    const tw = tipRef.current.offsetWidth;
    const th = tipRef.current.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;

    let top = r.bottom + GAP;
    if (top + th > vh - EDGE) {
      const above = r.top - GAP - th;
      if (above >= EDGE) top = above;
    }
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(EDGE, Math.min(left, vw - tw - EDGE));
    setPos({ left, top });
  }, [state]);

  if (!state) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="kn-tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {state.label}
    </div>,
    document.body,
  );
}
