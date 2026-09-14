// The Worker: the API under /api, and the built website for everything else. One deploy — `wrangler deploy`
// after `npm run build` — serves dist/ as static assets and answers /api from D1, on one origin, so the page
// talks to the registry with no CORS and no configuration. The site can also stay on a static host with /api
// rewritten to this Worker; see "Deploying the website" in the README.
import { handleApi } from './api.js';

// The address every card prints: llmscope.dev/<id>, and the older /e/<id> that earlier cards printed. The build
// has a page of its own for each bundled eval; every other id gets the root page, which reads the id out of the
// URL and asks the API — the same rule vercel.json and `llmscope serve` apply, so a link behaves the same
// wherever it is opened. /new is a built page and needs no rule here.
const EVAL_PAGE = /^\/(?:e\/)?[0-9A-Za-z]{6}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env);
    if (!env.ASSETS) return new Response('not found', { status: 404 });
    if (EVAL_PAGE.test(url.pathname)) {
      const built = await env.ASSETS.fetch(request);
      if (built.status !== 404) return built;
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
