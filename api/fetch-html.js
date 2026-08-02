// api/fetch-html.js
import * as cheerio from 'cheerio';

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
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    // Fetch the HTML page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CssScraperBot/1.0)'
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error: ${response.statusText}` });
    }

    const html = await response.text();

    // Parse with cheerio
    const $ = cheerio.load(html);

    // Determine the base URL: first try <base href="...">, else use the response URL
    let baseUrl = url;
    const baseTag = $('base[href]').first();
    if (baseTag.length) {
      const baseHref = baseTag.attr('href');
      // Resolve against the page URL (in case baseHref is relative)
      baseUrl = new URL(baseHref, url).href;
    }

    const stylesheets = [];

    // <link rel="stylesheet" href="...">
    $('link[rel="stylesheet"][href]').each((i, el) => {
      const href = $(el).attr('href').trim();
      if (!href) return;
      try {
        const absolute = new URL(href, baseUrl).href;
        stylesheets.push(absolute);
      } catch (e) {
        // ignore malformed
      }
    });

    // <link as="style" href="..."> (preload)
    $('link[as="style"][href]').each((i, el) => {
      const href = $(el).attr('href').trim();
      if (!href) return;
      try {
        const absolute = new URL(href, baseUrl).href;
        // Avoid duplicates if the same link appears both as rel and as
        if (!stylesheets.includes(absolute)) {
          stylesheets.push(absolute);
        }
      } catch (e) {
        // ignore malformed
      }
    });

    // Return the resolved URLs
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(stylesheets);
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch or parse page: ${err.message}` });
  }
}
