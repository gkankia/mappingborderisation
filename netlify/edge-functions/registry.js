/**
 * Parcel record proxy — Netlify Edge Function (Deno).
 *
 * Two things force this to live server-side:
 *
 *  1. CORS. When maps.gov.ge/lr/bo/mg/getinfo.alpha refuses a request it answers with
 *     a small "Access Denied" page carrying no Access-Control-Allow-Origin header, so
 *     a browser fetch dies before the app sees anything.
 *  2. Session. The record endpoint (BY_CADLIST.GETINFO) resolves its label against the
 *     session that produced it. Priming a session and asking for a label straight away
 *     returns a 106-byte empty wrapper; running the point search first in the SAME
 *     session returns the real ~25KB record. So both legs run here, together.
 *
 * The endpoint is also rate-limited rather than gated by any header — identical
 * requests are usually refused and occasionally served — hence a few spaced attempts
 * and a cache of anything real. The retry count is deliberately small; hammering the
 * WAF is what gets an address throttled in the first place.
 *
 * GET /api/registry?lng=..&lat=..&zoom=..
 *   200 { code, address, link, html, shp }
 *   404 { error: "no_parcel" }
 *   502 { error: "registry_denied" | "empty_record" | "upstream_unreachable" }
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ORIGIN = 'https://maps.gov.ge';
const BACKOFF_MS = [0, 600, 1500];
const CACHE = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDenied = html => /Access Denied|Oops! Something went wrong/i.test(html);
// A real record carries the attribute panel; the bare comment wrapper does not.
const isEmpty = html => !/bg-blue-100/.test(html);

const fail = (error, status = 502, extra = {}) =>
  new Response(JSON.stringify({ error, ...extra }), {
    status, headers: { 'Content-Type': 'application/json' }
  });

function session() {
  const jar = {};
  return {
    absorb(res) {
      (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
        .forEach(c => { const [k, v] = c.split(';')[0].split('='); if (k) jar[k.trim()] = v; });
    },
    headers(extra = {}) {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      return {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ka-GE,ka;q=0.9,en;q=0.8',
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra
      };
    }
  };
}

async function attempt(lng, lat, zoom, lang) {
  const s = session();

  s.absorb(await fetch(`${ORIGIN}/`, { redirect: 'manual', headers: s.headers() }));

  const form = new FormData();
  const d = 0.0025;
  form.append('keyword', `${lng},${lat}`);
  form.append('keyword_description[coords][]', String(lng));
  form.append('keyword_description[coords][]', String(lat));
  form.append('keyword_description[bbox][]', String(lng - d));
  form.append('keyword_description[bbox][]', String(lat - d));
  form.append('keyword_description[bbox][]', String(lng + d));
  form.append('keyword_description[bbox][]', String(lat + d));
  form.append('keyword_description[zoom]', String(zoom));
  form.append('keyword_description[lang]', lang);
  form.append('keyword_description[layers][]', '92');
  form.append('keyword_description[layers][]', '97');
  form.append('keyword_description[getinfo_type]', 'click');

  const sRes = await fetch(`${ORIGIN}/map/portal/search`, {
    method: 'POST', body: form, headers: s.headers({ 'X-Requested-With': 'XMLHttpRequest' })
  });
  s.absorb(sRes);
  if (!sRes.ok) return { error: 'search_failed' };

  const data = await sRes.json().catch(() => ({}));
  // The same call also returns registration borders and district sectors.
  const item = (data.result || []).find(r => /lbl=lr_parcels:/.test(r.details?.info_link || ''));
  if (!item) return { error: 'no_parcel' };
  const lbl = item.details.info_link.split('lbl=')[1];
  const enc = encodeURIComponent(lbl);

  const [hRes, sh] = await Promise.all([
    fetch(`${ORIGIN}/lr/bo/mg/getinfo.alpha?lbl=${enc}&lang=${lang}`, { headers: s.headers({ 'X-Requested-With': 'XMLHttpRequest' }) }),
    fetch(`${ORIGIN}/lr/bo/mg/getinfo.alpha?lbl=${enc}&res=shp&lang=${lang}`, { headers: s.headers({ 'X-Requested-With': 'XMLHttpRequest' }) })
  ]);
  const html = await hRes.text();
  if (isDenied(html)) return { error: 'registry_denied' };
  if (isEmpty(html)) return { error: 'empty_record' };

  const shpText = await sh.text();
  let shp = null;
  try { shp = isDenied(shpText) ? null : JSON.parse(shpText); } catch { shp = null; }

  return {
    code: item.name || lbl,
    address: item.descript || '',
    link: `${ORIGIN}${item.details.info_link}`,
    html,
    shp
  };
}

export default async (request) => {
  const url = new URL(request.url);
  const lng = Number(url.searchParams.get('lng'));
  const lat = Number(url.searchParams.get('lat'));
  const zoom = Number(url.searchParams.get('zoom')) || 16;
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ka';

  if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
      lng < 39 || lng > 47 || lat < 40.5 || lat > 44) {
    return fail('bad_coords', 400);
  }

  // ~11 m of precision: repeat clicks on the same parcel reuse one answer.
  const key = `${lng.toFixed(4)},${lat.toFixed(4)},${lang}`;
  const hit = CACHE.get(key);
  if (hit) {
    return new Response(hit, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'hit' }
    });
  }

  try {
    let last = null;
    for (let i = 0; i < BACKOFF_MS.length; i++) {
      if (BACKOFF_MS[i]) await sleep(BACKOFF_MS[i]);
      const out = await attempt(lng, lat, zoom, lang);
      if (!out.error) {
        const payload = JSON.stringify(out);
        CACHE.set(key, payload);
        return new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'X-Attempts': String(i + 1) }
        });
      }
      last = out.error;
      if (last === 'no_parcel') return fail('no_parcel', 404);   // retrying will not help
    }
    return fail(last || 'registry_denied', 502, { attempts: BACKOFF_MS.length });
  } catch (err) {
    return fail('upstream_unreachable', 502, { detail: String(err && err.message) });
  }
};

export const config = { path: '/api/registry' };
