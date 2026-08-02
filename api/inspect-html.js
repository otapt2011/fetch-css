// api/inspect-html.js
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export default async function handler(req, res) {
  // CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });

  const forceDynamic = req.query.dynamic === 'true';
  const debug = req.query.debug === 'true';
  const waitMs = parseInt(req.query.wait) || 0;

  // Helper: clean head from HTML (works for both static and dynamic)
  function cleanHead(html) {
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return '';
    let head = headMatch[1];

    // Remove <script>...<\/script>
    head = head.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    // Remove <link rel="alternate" ...>
    head = head.replace(/<link\b[^>]*?\brel\s*=\s*["'][^"']*\balternate\b[^"']*["'][^>]*\/?>/gi, '');
    // Remove <link rel="preconnect" ...>
    head = head.replace(/<link\b[^>]*?\brel\s*=\s*["'][^"']*\bpreconnect\b[^"']*["'][^>]*\/?>/gi, '');
    // Remove <link as="script" ...>
    head = head.replace(/<link\b[^>]*?\bas\s*=\s*["']script["'][^>]*\/?>/gi, '');
    // Remove <link as="image" ...>
    head = head.replace(/<link\b[^>]*?\bas\s*=\s*["']image["'][^>]*\/?>/gi, '');
    // Remove <base ...>
    head = head.replace(/<base\b[^>]*\/?>/gi, '');
    // Remove Open Graph <meta property="og:...">
    head = head.replace(/<meta\b[^>]*?\bproperty\s*=\s*["']og:[^"']*["'][^>]*\/?>/gi, '');

    return head.trim();
  }

  // Helper: extract opening tag attributes
  function extractTagAttrs(html, tag) {
    const match = html.match(new RegExp(`<${tag}\\b([^>]*)>`, 'i'));
    return match ? `<${tag}${match[1]}>` : '';
  }

  // Static extraction (cheerio) – fast path
  if (!forceDynamic) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) throw new Error(`Upstream error: ${response.statusText}`);
      const html = await response.text();
      const $ = cheerio.load(html);

      let baseUrl = url;
      const baseTag = $('base[href]').first();
      if (baseTag.length) baseUrl = new URL(baseTag.attr('href'), url).href;

      const stylesheets = [];
      $('link[rel="stylesheet"][href]').each((_, el) => {
        const href = $(el).attr('href').trim();
        if (!href) return;
        try { stylesheets.push(new URL(href, baseUrl).href); } catch {}
      });
      $('link[as="style"][href]').each((_, el) => {
        const href = $(el).attr('href').trim();
        if (!href) return;
        try {
          const abs = new URL(href, baseUrl).href;
          if (!stylesheets.includes(abs)) stylesheets.push(abs);
        } catch {}
      });

      // If we got some stylesheets, return static result
      if (stylesheets.length > 0) {
        const payload = {
          url,
          finalUrl: url,
          canonical: $('link[rel="canonical"]').attr('href') || null,
          htmlAttrs: extractTagAttrs(html, 'html'),
          bodyAttrs: extractTagAttrs(html, 'body'),
          cleanedHead: cleanHead(html),
          stylesheets
        };
        if (debug) payload.debug = { mode: 'static' };
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(payload);
      }
    } catch (e) {
      console.warn('Static parsing failed, falling back to headless browser:', e.message);
    }
  }

  // Dynamic headless browser path
  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Stealth
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // Set cookies to simulate returning visitor
    const domain = new URL(url).hostname;
    await page.setCookie(
      { name: 'visitor', value: 'true', domain, path: '/' },
      { name: 'session', value: 'active', domain, path: '/' }
    );

    // Intercept network stylesheet requests
    const stylesheetUrls = new Set();
    await page.setRequestInterception(true);
    page.on('request', (request) => request.continue());
    page.on('response', (response) => {
      if (response.request().resourceType() === 'stylesheet') {
        stylesheetUrls.add(response.url());
      }
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Extra wait if requested
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    // Simulate user presence
    await page.mouse.move(100, 100);
    await page.evaluate(() => window.scrollBy(0, 100));

    // Extract data from final DOM
    const { finalUrl, canonical, htmlAttrs, bodyAttrs, domStylesheets } = await page.evaluate(() => {
      const final = window.location.href;
      const canonEl = document.querySelector('link[rel="canonical"]');
      const canon = canonEl ? canonEl.href : null;

      const htmlTag = document.documentElement.outerHTML.match(/<html[^>]*>/)?.[0] || '';
      const bodyTag = document.body.outerHTML.match(/<body[^>]*>/)?.[0] || '';

      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"], link[as="style"]'));
      const sheets = links.map(l => l.href).filter(h => h);

      return { finalUrl: final, canonical: canon, htmlAttrs: htmlTag, bodyAttrs: bodyTag, domStylesheets: sheets };
    });

    // Combine network and DOM stylesheets
    domStylesheets.forEach(href => stylesheetUrls.add(href));
    const allStylesheets = Array.from(stylesheetUrls);

    // Get the final HTML for cleaning head
    const finalHtml = await page.content();
    const cleanedHead = cleanHead(finalHtml);

    await browser.close();

    const payload = {
      url,
      finalUrl,
      canonical,
      htmlAttrs,
      bodyAttrs,
      cleanedHead,
      stylesheets: allStylesheets
    };
    if (debug) payload.debug = { mode: 'dynamic' };

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(payload);
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: `Failed to fetch page: ${err.message}` });
  }
}
