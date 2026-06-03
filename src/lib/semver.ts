/**
 * Minimal semver support — just enough to classify the gap between two
 * versions for the upgrade flow. Deliberately dependency-free (the repo has
 * no `semver` package) and tolerant: pre-release/build metadata is ignored,
 * and unparseable input is treated as 0.0.0 so a malformed version never
 * throws in the render path.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type Bump = 'major' | 'minor' | 'patch' | 'none';

/** Parse "X.Y.Z" (ignoring any leading "v" and trailing "-rc1"/"+meta"). */
export function parse(version: string): SemVer {
  const core = String(version).trim().replace(/^v/i, '').split(/[-+]/)[0];
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((n) => {
      const v = parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
  return { major, minor, patch };
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] < y[k]) return -1;
    if (x[k] > y[k]) return 1;
  }
  return 0;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compare(latest, current) === 1;
}

/**
 * Classify the difference `from → to`. Returns the highest-significance field
 * that changed. Direction-agnostic (a downgrade still reports the field that
 * differs) — callers decide whether the direction matters.
 */
export function classifyBump(from: string, to: string): Bump {
  const a = parse(from);
  const b = parse(to);
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'none';
}
