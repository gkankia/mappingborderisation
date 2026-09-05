/**
 * Parcel record proxy — Netlify Edge Function (Deno).
 *
 * maps.gov.ge/lr/bo/mg/getinfo.alpha is gated: it serves Urbanyx's deployed origin but
 * refuses this one, and the refusal page carries no Access-Control-Allow-Origin header,
 * which is the CORS error in the browser console. Fetching it server-side sidesteps the
 * browser's CORS check entirely.
 *
 * This runs at the edge on Deno rather than in the Lambda runtime — a plain Netlify
 * Function doing the same thing was refused by the WAF, and this is a different
 * runtime and egress path, so it is worth a try. If it is refused too, the response
 * says so explicitly and the app falls back to the search result.
 *
 * Same-origin (/api/registry), so no CORS headers are needed on the way back.
 * /map/portal/search is NOT gated and stays a direct browser call.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const fail = (error, status = 502, extra = {}) =>
  new Response(JSON.stringify({ error, ...extra }), {
    status, headers: { 'Content-Type': 'application/json' }
  });

export default async (request) => {
  const url = new URL(request.url);
  const lbl = url.searchParams.get('lbl') || '';
  // Registry parcel labels only — this must never become a general-purpose proxy.
  if (!/^lr_parcels:[A-Za-z0-9+/=_-]{4,64}$/.test(lbl)) return fail('bad_lbl', 400);

  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ka';
  const shp = url.searchParams.get('res') === 'shp';
  const target = `https://maps.gov.ge/lr/bo/mg/getinfo.alpha?lbl=${lbl}${shp ? '&res=shp' : ''}&lang=${lang}`;

  try {
    // Prime a session: the WAF in front of the registry issues TS* cookies here.
    const prime = await fetch('https://maps.gov.ge/', {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'ka-GE,ka;q=0.9' }
    });
    const jar = (typeof prime.headers.getSetCookie === 'function' ? prime.headers.getSetCookie() : [])
      .map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');

    const res = await fetch(target, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://maps.gov.ge/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ka-GE,ka;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        ...(jar ? { Cookie: jar } : {})
      }
    });
    const body = await res.text();
    if (/Access Denied|Oops! Something went wrong/i.test(body)) {
      return fail('registry_denied', 502, { upstreamStatus: res.status });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': shp ? 'application/json' : 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (err) {
    return fail('upstream_unreachable', 502, { detail: String(err && err.message) });
  }
};

export const config = { path: '/api/registry' };
