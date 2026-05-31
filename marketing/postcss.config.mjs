// Empty PostCSS config so Next.js stops walking up to the root kennook-app's
// `postcss.config.mjs` (which loads Tailwind for the app, but the marketing
// site doesn't use Tailwind yet). When marketing wants Tailwind, swap this
// for the standard `{ tailwindcss: {}, autoprefixer: {} }` and add a sibling
// `tailwind.config.ts` with marketing-specific content paths.
const config = {
  plugins: {},
};

export default config;
