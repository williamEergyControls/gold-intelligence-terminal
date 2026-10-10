import type { Env } from './types';

/* ================================================================
   SEO ROUTES — answered by the Worker before static assets (wrangler.jsonc run_worker_first)
   INIT     path is /robots.txt, /sitemap.xml or /google*.html
   EVALUATE google file: answered ONLY when it equals env.GOOGLE_SITE_VERIFICATION
            (anyone else's file name gets 404, so nobody else can claim the domain)
   PUBLISH  plain text / xml built from the request host (works on workers.dev and a custom domain)
   ================================================================ */

/** public pages only: every desk needs a sign-in, so Google would just see the login screen */
const PUBLIC_PAGES: { path: string; freq: string; prio: string }[] = [
  { path: '/', freq: 'daily', prio: '1.0' },
  { path: '/sitemap', freq: 'weekly', prio: '0.8' },   // assets serve /x.html at /x (307 otherwise)
  { path: '/login', freq: 'monthly', prio: '0.5' },
];

export function seoRoute(req: Request, env: Env, url: URL): Response | null {
  const p = url.pathname;
  const origin = url.origin;
  if (p === '/robots.txt') {
    return new Response(
      `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /diagnostics\n\nSitemap: ${origin}/sitemap.xml\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (p === '/sitemap.xml') {
    const day = new Date().toISOString().slice(0, 10);
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      PUBLIC_PAGES.map(x => `  <url><loc>${origin}${x.path}</loc><lastmod>${day}</lastmod><changefreq>${x.freq}</changefreq><priority>${x.prio}</priority></url>`).join('\n') +
      '\n</urlset>\n';
    return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (/^\/google[a-z0-9]{6,40}(\.html)?$/i.test(p)) {
    // compare without ".html" on either side: the setting may be saved with or without it
    const want = (env.GOOGLE_SITE_VERIFICATION || '').trim().replace(/^\//, '').replace(/\.html$/i, '');
    const file = p.slice(1).replace(/\.html$/i, '');
    if (want && file === want) {
      return new Response('google-site-verification: ' + want + '.html\n', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  }
  return null;
}
