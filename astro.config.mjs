// The website is an Astro site whose app code is the same engine the CLI runs: `site/src/pages/index.astro`
// pulls in `web/app.js`, which imports `src/*.js` directly. Nothing is duplicated for the browser, so a change
// to a renderer or a check shows up in both places at once.
//
// Astro's own defaults are moved aside because `src/` is already the engine's: the site's pages live under
// `site/src`, its generated static files under `site/public`, and only the build output sits at `dist/`, where
// Vercel's zero-config Astro detection expects it.
import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

const stub = (name) => fileURLToPath(new URL(`./site/stubs/${name}.js`, import.meta.url));

// Absolute URLs for the canonical link and the social-card tags. Vercel exports the production domain, so a
// preview deploy points at the real site rather than at itself; SITE_URL overrides both.
const site = process.env.SITE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
  || 'https://llmscope.dev';

export default defineConfig({
  site,
  srcDir: './site/src',
  publicDir: './site/public',
  outDir: './dist',
  build: { assets: '_assets' },
  vite: {
    resolve: {
      // Three specifiers the engine reaches for only when it is running under Node. Each is behind a
      // `typeof document === 'undefined'` test or a try/catch, so the browser never evaluates them — but Vite
      // resolves imports at build time regardless of whether they can run, and a native addon or a node:
      // builtin fails that resolution. The stubs let the bundle build and keep the Node-only paths honest by
      // throwing if anything ever does call them.
      alias: [
        { find: /^@napi-rs\/canvas$/, replacement: stub('napi-canvas') },
        { find: /^node:module$/, replacement: stub('node-module') },
        { find: /^sentiment$/, replacement: stub('sentiment') },
      ],
    },
  },
});
