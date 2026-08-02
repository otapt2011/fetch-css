// api/fetch-web.js
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

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

  const forceDynamic = req.query.dynamic === 'true';

  // 1. Try static parsing first (fast) unless forced
  if (!forceDynamic) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CssScraperBot/1.0)' }
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

      // If we got something, return it
      if (stylesheets.length > 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(stylesheets);
      }
    } catch (e) {
      console.warn('Static parsing failed, falling back to headless browser:', e.message);
    }
  }

  // 2. Dynamic headless browser (Puppeteer + @sparticuz/chromium)
  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    const stylesheets = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll('link[rel="stylesheet"], link[as="style"]')
      );
      return links.map(link => link.href).filter(h => h);
    });

    await browser.close();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(stylesheets);
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: `Failed to fetch page: ${err.message}` });
  }
}
