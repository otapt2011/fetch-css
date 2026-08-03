// api/web-scraper.js
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  const action = req.query.action || 'proxy'; // default: proxy resource

  if (action === 'inspect') {
    // ---------- PAGE INSPECTION ----------
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) throw new Error(`Upstream error: ${response.statusText}`);
      const html = await response.text();
      const $ = cheerio.load(html);

      // Extract opening tags attributes
      const htmlAttrs = (html.match(/<html\b([^>]*)>/i) || [''])[0];
      const bodyAttrs = (html.match(/<body\b([^>]*)>/i) || [''])[0];

      // Clean head
      let headContent = '';
      const head = $('head');
      if (head.length) {
        head.find('script').remove();
        head.find('link').each((_, el) => {
          const $el = $(el);
          const rel = ($el.attr('rel') || '').toLowerCase();
          const as = ($el.attr('as') || '').toLowerCase();
          if (rel.includes('alternate') || rel.includes('preconnect') || rel.includes('dns') ||
              as === 'script' || as === 'image') {
            $el.remove();
          }
        });
        head.find('base').remove();
        head.find('meta').each((_, el) => {
          const $el = $(el);
          const charset = $el.attr('charset');
          const name = $el.attr('name');
          const property = $el.attr('property');
          if (!charset && name !== 'viewport') {
            $el.remove();
          }
          if (property && property.toLowerCase().startsWith('og:')) {
            $el.remove();
          }
        });
        headContent = head.html() || '';
      }

      // Clean body
      let bodyContent = '';
      const body = $('body');
      if (body.length) {
        body.find('script').remove();
        body.find('meta').remove();
        body.find('ins').remove();
        bodyContent = body.html() || '';
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({
        htmlAttrs,
        bodyAttrs,
        cleanedHead: headContent.trim(),
        cleanedBody: bodyContent.trim()
      });

    } catch (err) {
      return res.status(500).json({ error: `Failed to inspect page: ${err.message}` });
    }
  }

  // ---------- RESOURCE PROXY ----------
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Upstream error: ${response.statusText}`);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch resource: ${err.message}` });
  }
}
