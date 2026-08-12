import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ESLint 9 flat config for the Next.js app. `next/core-web-vitals` bundles the
// React, React-Hooks (incl. `react-hooks/rules-of-hooks` as an ERROR — the guard
// that would have caught the 0.6.0 hooks-order crash), and Next.js plugins.
// Run via `pnpm lint` (or `pnpm exec eslint <file>` after an edit).
const compat = new FlatCompat({
  baseDirectory: __dirname,
  resolvePluginsRelativeTo: __dirname, // pnpm-safe plugin resolution
});

export default [
  {
    ignores: [
      '.next/**',
      '.next-prod/**',
      '.marketing-deploy/**',
      'node_modules/**',
      'out/**',
      'next-env.d.ts',
      'data/**',
      'public/**',
    ],
  },
  // `next/typescript` loads the @typescript-eslint rules the codebase already
  // has inline eslint-disable comments for (without it, those comments error as
  // "rule not found").
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];
