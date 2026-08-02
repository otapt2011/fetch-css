// api/inspect-html.js
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
  const waitMs = parseInt(req.query.wait) || 0;

  function cleanHead(html) {
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return '';
    let head = headMatch[1];

    head = head.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    head = head.replace(/<link\b[^>]*?\brel\s*=\s*["'][^"']*\balternate\b[^"']*["'][^>]*\/?>/gi, '');
    head = head.replace(/<link\b[^>]*?\brel\s*=\s*["'][^"']*\bpreconnect\b[^"']*["'][^>]*\/?>/gi, '');
    head = head.replace(/<link\b[^>]*?\brel\s*=\s*["'][^"']*dns[^"']*["'][^>]*\/?>/gi, '');
    head = head.replace(/<link\b[^>]*?\bas\s*=\s*["']script["'][^>]*\/?>/gi, '');
    head = head.replace(/<link\b[^>]*?\bas\s*=\s*["']image["'][^>]*\/?>/gi, '');
    head = head.replace(/<base\b[^>]*\/?>/gi, '');

    // Keep only charset and viewport meta tags
    head = head.replace(/<meta\b[^>]*(?<!\bcharset\s*=\s*["'][^"']*["'])(?<!\bname\s*=\s*["']viewport["'])[^>]*\/?>/gi, '');
    head = head.replace(/<meta\b[^>]*?\bproperty\s*=\s*["']og:[^"']*["'][^>]*\/?>/gi, '');

    head = head.replace(/^\s*[\r\n]/gm, '');
    return head.trim();
  }

  function extractTagAttrs(html, tag) {
    const match = html.match(new RegExp(`<${tag}\\b([^>]*)>`, 'i'));
    return match ? `<${tag}${match[1]}>` : '';
  }

  // Extract body inner HTML and remove all <script>...</script>
  function cleanBody(html) {
    const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    if (!bodyMatch) return '';
    let bodyContent = bodyMatch[1];
    // Remove script tags
    bodyContent = bodyContent.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    return bodyContent.trim();
  }

  // Static extraction
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' }
    });
    if (!response.ok) throw new Error(`Upstream error: ${response.statusText}`);
    const html = await response.text();

    const payload = {
      htmlAttrs: extractTagAttrs(html, 'html'),
      bodyAttrs: extractTagAttrs(html, 'body'),
      cleanedHead: cleanHead(html),
      cleanedBody: cleanBody(html)
    };
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(payload);
  } catch (e) {
    if (forceDynamic) {
      let browser = null;
      try {
        browser = await puppeteer.launch({
          args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
          defaultViewport: { width: 1920, height: 1080 },
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
          ignoreHTTPSErrors: true,
        });
        const page = await browser.newPage();
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
        const domain = new URL(url).hostname;
        await page.setCookie(
          { name: 'visitor', value: 'true', domain, path: '/' },
          { name: 'session', value: 'active', domain, path: '/' }
        );
        await page.evaluateOnNewDocument(() => {
          localStorage.setItem('visited', 'true');
          sessionStorage.setItem('active', 'true');
        });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.mouse.move(100, 100);
        await page.evaluate(() => window.scrollBy(0, 100));
        if (waitMs > 0) await page.waitForTimeout(waitMs);
        const finalHtml = await page.content();
        await browser.close();

        const payload = {
          htmlAttrs: extractTagAttrs(finalHtml, 'html'),
          bodyAttrs: extractTagAttrs(finalHtml, 'body'),
          cleanedHead: cleanHead(finalHtml),
          cleanedBody: cleanBody(finalHtml)
        };
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(payload);
      } catch (err) {
        if (browser) await browser.close();
        return res.status(500).json({ error: `Headless browser failed: ${err.message}` });
      }
    }
    return res.status(500).json({ error: `Failed to fetch page: ${e.message}` });
  }
}
