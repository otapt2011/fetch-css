// api/fetch-css.js
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const url = req.query.url;
  if (!url) {
    res.status(400).json({ error: 'Missing "url" query parameter' });
    return;
  }

  try {
    // Fetch the remote CSS
    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).json({ error: `Upstream error: ${response.statusText}` });
      return;
    }

    // Forward content type and length if available
    const contentType = response.headers.get('content-type') || 'text/css';
    const contentLength = response.headers.get('content-length');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Stream the body back to the client
    const reader = response.body.getReader();
    res.setHeader('Transfer-Encoding', 'chunked');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch the CSS file' });
  }
}
