/**
 * Paste this block into the existing Urbanyx worker (spring-recipe-402c), alongside
 * the /wms and /permits routes, then set REGISTRY_PROXY in index.html to
 *   https://<worker-host>/registry
 *
 * Why: maps.gov.ge/lr/bo/mg/getinfo.alpha sits behind an F5 BIG-IP WAF. It answers
 * Urbanyx's deployed origin but refuses mappingborderisation.netlify.app, and the
 * refusal page carries no Access-Control-Allow-Origin header — which is exactly the
 * CORS error in the console. Fetching it server-side sidesteps the browser's CORS
 * check entirely; the priming request picks up the TS* session cookies the WAF wants.
 *
 * Note: /map/portal/search is NOT gated and already answers the browser directly, so
 * only the record half needs proxying.
 */

// ── Public registry: parcel record by label (GET) ────────────────────────────
// /registry?lbl=lr_parcels:XXXX[&res=shp][&lang=ka]
if (request.method === "GET" && url.pathname === "/registry") {
  const lbl = url.searchParams.get("lbl") || "";
  // Registry parcel labels only — never let this become a general-purpose proxy.
  if (!/^lr_parcels:[A-Za-z0-9+/=_-]{4,64}$/.test(lbl)) {
    return new Response(JSON.stringify({ error: "bad_lbl" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  const lang = url.searchParams.get("lang") === "en" ? "en" : "ka";
  const shp  = url.searchParams.get("res") === "shp";
  const target = `https://maps.gov.ge/lr/bo/mg/getinfo.alpha?lbl=${lbl}${shp ? "&res=shp" : ""}&lang=${lang}`;
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
             "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  try {
    // 1. prime — the portal hands out the TS* WAF cookies
    const prime = await fetch("https://maps.gov.ge/", {
      redirect: "manual",
      headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "ka-GE,ka;q=0.9" }
    });
    const raw = typeof prime.headers.getSetCookie === "function"
      ? prime.headers.getSetCookie()
      : (prime.headers.get("set-cookie") || "").split(/,(?=[^;]+=)/);
    const cookie = raw.map(c => (c || "").split(";")[0].trim()).filter(Boolean).join("; ");

    // 2. the record, carrying that session
    const res = await fetch(target, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://maps.gov.ge/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        ...(cookie ? { "Cookie": cookie } : {})
      }
    });
    const body = await res.text();

    if (/Access Denied|Oops! Something went wrong/i.test(body)) {
      return new Response(JSON.stringify({ error: "registry_denied" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": shp ? "application/json" : "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream", detail: e.message }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
