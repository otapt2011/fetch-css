// api/fetch-html.js
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export default async function handler(req, res) {
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

  const forceDynamic = req.query.dynamic === 'true';
  const debug = req.query.debug === 'true';
  const waitMs = parseInt(req.query.wait) || 0;   // extra wait in ms after idle (e.g., wait=2000)

  // 1. Static extraction (unless forced)
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
      if (baseTag.length) {
        baseUrl = new URL(baseTag.attr('href'), url).href;
      }

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

      if (stylesheets.length > 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const payload = { url, stylesheets };
        if (debug) {
          payload.finalUrl = url;
          payload.canonical = $('link[rel="canonical"]').attr('href') || null;
        }
        return res.status(200).json(payload);
      }
    } catch (e) {
      console.warn('Static parsing failed, falling back to headless browser:', e.message);
    }
  }

  // 2. Dynamic headless browser (stealth + extra wait)
  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--disable-blink-features=AutomationControlled',   // hide automation
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // ---- Stealth configuration ----
    await page.evaluateOnNewDocument(() => {
      // Overwrite the `navigator.webdriver` property
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Overwrite `navigator.plugins` length (bots often have 0)
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      // Overwrite `navigator.languages`
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      // Pass the Chrome runtime check
      window.chrome = { runtime: {} };
    });

    // Set a realistic user agent and extra headers
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Extra wait if requested (allows dynamic JS to finish injecting styles)
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    // Extract final URL, canonical, and stylesheets
    const { finalUrl, canonical, stylesheets } = await page.evaluate(() => {
      const final = window.location.href;
      const canonEl = document.querySelector('link[rel="canonical"]');
      const canon = canonEl ? canonEl.href : null;
      const links = Array.from(
        document.querySelectorAll('link[rel="stylesheet"], link[as="style"]')
      );
      const sheets = links.map(link => link.href).filter(h => h);
      return { finalUrl: final, canonical: canon, stylesheets: sheets };
    });

    await browser.close();

    res.setHeader('Access-Control-Allow-Origin', '*');
    const payload = { url, finalUrl, canonical, stylesheets };
    return res.status(200).json(payload);
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: `Failed to fetch page: ${err.message}` });
  }
}
