'use client';

/**
 * Eight-particle burst centered on its positioned parent. Mount it with
 * `key={someCounter}` so each new value re-mounts the component and
 * restarts the animation.
 *
 * Renders nothing structurally meaningful — pure visual flourish — so
 * it carries no aria role and is `pointer-events-none` end-to-end.
 *
 * Pair with a parent that has `position: relative` so the absolute
 * particles anchor to the parent's center (the heart icon, typically).
 */
export function SparkleBurst() {
  // Angles are spread around the circle but offset every other one so
  // the burst doesn't read as a perfectly symmetric snowflake.
  const angles = [0, 45, 90, 135, 180, 225, 270, 315].map(
    (a, i) => a + (i % 2 === 0 ? 0 : 11),
  );
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      {angles.map((angle, i) => (
        <span
          key={i}
          className="kn-sparkle"
          style={
            {
              ['--kn-spark-angle' as string]: `${angle}deg`,
              // Tiny per-particle stagger so they don't all peak together;
              // adds organic flicker without dragging out the burst.
              animationDelay: `${i * 10}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
