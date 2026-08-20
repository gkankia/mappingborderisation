export default async (req) => {
  try {
    const url = new URL(req.url);
    const queryString = url.searchParams.toString();
    const targetUrl = `https://nsdi.gov.ge/geoserver/wms?${queryString}`;

    const response = await fetch(targetUrl);

    if (!response.ok) {
      return new Response('Failed to fetch tile from NSDI server.', { status: response.status });
    }

    const arrayBuffer = await response.arrayBuffer();

    return new Response(arrayBuffer, {
      status: 250,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error proxying WMS tile:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};