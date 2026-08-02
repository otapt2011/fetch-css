// api/fetch-web.js
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
  if (!url) return res.status(400).json({ error: 'Missing "url" query parameter' });

  const forceDynamic = req.query.dynamic === 'true';
  const debug = req.query.debug === 'true';
  const waitMs = parseInt(req.query.wait) || 0;

  // 1. Static extraction (cheerio) – unchanged, but now we'll always return even if empty
  if (!forceDynamic) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' }
      });
      if (!response.ok) throw new Error(`Upstream error: ${response.statusText}`);
      const html = await response.text();
      const $ = cheerio.load(html);

      let baseUrl = url;
      const baseTag = $('base[href]').first();
      if (baseTag.length) baseUrl = new URL(baseTag.attr('href'), url).href;

      const stylesheets = [];
      $('link[rel="stylesheet"][href]').each((_, el) => {
        try { stylesheets.push(new URL($(el).attr('href').trim(), baseUrl).href); } catch {}
      });
      $('link[as="style"][href]').each((_, el) => {
        try {
          const abs = new URL($(el).attr('href').trim(), baseUrl).href;
          if (!stylesheets.includes(abs)) stylesheets.push(abs);
        } catch {}
      });

      // Always return static result; dynamic will be an add-on if forced
      if (!forceDynamic) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const payload = { url, stylesheets };
        if (debug) {
          payload.finalUrl = url;
          payload.canonical = $('link[rel="canonical"]').attr('href') || null;
        }
        return res.status(200).json(payload);
      }
    } catch (e) {
      console.warn('Static parsing failed:', e.message);
    }
  }

  // 2. Dynamic – intercept all .css requests
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

    // Collect all stylesheet URLs from network requests
    const stylesheetUrls = new Set();

    await page.setRequestInterception(true);
    page.on('request', (request) => request.continue());
    page.on('response', (response) => {
      if (response.request().resourceType() === 'stylesheet') {
        stylesheetUrls.add(response.url());
      }
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    // Also capture any <link> still in DOM for safety
    const domLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"], link[as="style"]'));
      return links.map(l => l.href).filter(h => h);
    });
    domLinks.forEach(href => stylesheetUrls.add(href));

    const finalUrl = await page.evaluate(() => window.location.href);
    const canonical = await page.evaluate(() => {
      const el = document.querySelector('link[rel="canonical"]');
      return el ? el.href : null;
    });

    await browser.close();

    res.setHeader('Access-Control-Allow-Origin', '*');
    const payload = {
      url,
      finalUrl,
      canonical,
      stylesheets: Array.from(stylesheetUrls)
    };
    return res.status(200).json(payload);
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: `Failed to fetch page: ${err.message}` });
  }
}
