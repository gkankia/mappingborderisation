/**
 * Public-registry parcel lookup, done entirely server-side.
 *
 * Why this exists: maps.gov.ge/lr/bo/mg/getinfo.alpha sits behind an F5 BIG-IP WAF.
 * Requests it does not recognise get a small "Access Denied" page carrying NO
 * Access-Control-Allow-Origin header, so a browser fetch dies on CORS before the app
 * sees anything. Getting a record needs the TS* session cookies the portal issues and
 * a same-origin Referer — neither of which a browser can supply cross-origin.
 *
 * Both legs (point search, then record) run here inside ONE cookie session, because
 * the record endpoint (BY_CADLIST.GETINFO) appears to resolve its label against the
 * session that produced it: priming alone has returned an empty record wrapper.
 *
 * GET /api/registry-info?lng=..&lat=..&zoom=..
 *   200 { code, link, html }        record HTML for the client to parse
 *   404 { error: "no_parcel" }      nothing registered at that point
 *   502 { error: "registry_denied" | "empty_record" | "upstream_unreachable" }
 */
const ORIGIN = 'https://maps.gov.ge';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const isDenied = html => /Access Denied|Oops! Something went wrong/i.test(html);
// A genuine record is ~25KB; the bare comment wrapper means the label resolved to nothing.
const isEmpty = html => !/bg-blue-100/.test(html);

function makeSession() {
  const jar = {};
  return {
    absorb(res) {
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      raw.forEach(c => { const [k, v] = c.split(';')[0].split('='); if (k) jar[k.trim()] = v; });
    },
    headers(extra = {}) {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      return {
        'User-Agent': UA,
        'Referer': `${ORIGIN}/`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ka-GE,ka;q=0.9,en;q=0.8',
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra
      };
    }
  };
}

async function lookup(lng, lat, zoom, lang) {
  const s = makeSession();

  // 1. prime — the portal issues the TS* WAF cookies here
  s.absorb(await fetch(`${ORIGIN}/`, {
    redirect: 'manual',
    headers: s.headers({ 'Upgrade-Insecure-Requests': '1' })
  }));

  // 2. point search — not WAF-gated, and it seats the parcel in this session
  const form = new FormData();
  const d = 0.002;
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
  if (!sRes.ok) return { error: 'search_failed', status: sRes.status };

  const data = await sRes.json().catch(() => ({}));
  // The same call also returns registration borders and district sectors — keep parcels.
  const item = (data.result || []).find(r => /lbl=lr_parcels:/.test(r.details?.info_link || ''));
  if (!item) return { error: 'no_parcel' };
  const lbl = item.details.info_link.split('lbl=')[1];

  // 3. the record, in the same session
  const rRes = await fetch(`${ORIGIN}/lr/bo/mg/getinfo.alpha?lbl=${encodeURIComponent(lbl)}&lang=${lang}`, {
    headers: s.headers({
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'
    })
  });
  const html = await rRes.text();
  if (isDenied(html)) return { error: 'registry_denied', status: rRes.status };
  if (isEmpty(html)) return { error: 'empty_record', status: rRes.status };

  return { code: item.name || lbl, link: `${ORIGIN}${item.details.info_link}`, html };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const lng = Number(url.searchParams.get('lng'));
  const lat = Number(url.searchParams.get('lat'));
  const zoom = Number(url.searchParams.get('zoom')) || 16;
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ka';

  if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
      lng < 39 || lng > 47 || lat < 40.5 || lat > 44) {
    return json(400, { error: 'bad_coords' });
  }

  try {
    // One retry: a stale session shows up as a denial rather than an error status.
    let out = await lookup(lng, lat, zoom, lang);
    if (out.error === 'registry_denied' || out.error === 'empty_record') {
      out = await lookup(lng, lat, zoom, lang);
    }
    if (out.error === 'no_parcel') return json(404, out);
    if (out.error) return json(502, out);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
    });
  } catch (err) {
    console.error('registry-info failed:', err);
    return json(502, { error: 'upstream_unreachable', detail: String(err && err.message) });
  }
};
