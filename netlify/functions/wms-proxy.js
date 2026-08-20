// Passthrough for the NAPR WMS services used by index.html.
// Each dataset lives in its own workspace, so the caller passes ?ws=<workspace>
// and the remaining query string is forwarded verbatim to
//   https://mp.napr.gov.ge/<workspace>/ows
// Only the workspaces below are allowed, so this cannot be used as an open proxy.
const ALLOWED_WORKSPACES = new Set([
  'TOPO_10k_1952_2007',
  'TOPO_50k_1973-1990',
  'TOPO_1000k_1988-90'
]);

export default async (req) => {
  try {
    const url = new URL(req.url);
    const params = new URLSearchParams(url.search);
    const workspace = params.get('ws');
    params.delete('ws');

    if (!workspace || !ALLOWED_WORKSPACES.has(workspace)) {
      return new Response(`Unknown or missing workspace: ${workspace}`, { status: 400 });
    }

    const targetUrl = `https://mp.napr.gov.ge/${workspace}/ows?${params.toString()}`;
    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      return new Response(`Upstream WMS error ${response.status}: ${await response.text()}`, { status: 502 });
    }

    // The server answers malformed requests with HTTP 200 + a ServiceExceptionReport,
    // which Mapbox would silently drop as an undecodable tile. Surface it instead.
    if (!contentType.startsWith('image/')) {
      return new Response(`Upstream WMS exception: ${await response.text()}`, { status: 502 });
    }

    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error proxying WMS tile:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
