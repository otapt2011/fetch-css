/**
 * webScrapper.js – IIFE module
 * Dependencies: JSZip (global JSZip)
 *
 * Usage:
 *   const blob = await WebScraper.scrape('https://example.com', {
 *     apiBase: 'https://fetch-css.vercel.app/api/web-scraper',
 *     onProgress: (info) => console.log(info)
 *   });
 */
;(function () {
  'use strict';

  if (typeof JSZip === 'undefined') {
    console.error('WebScraper: JSZip is required. Include it before this script.');
    return;
  }

  // -------- Internal helpers (from cssScrapper.js) --------
  const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','tiff']);
  const FONT_EXTS  = new Set(['woff','woff2','ttf','otf','eot']);

  function getCategory(filename) {
    const ext = filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'images';
    if (FONT_EXTS.has(ext))  return 'fonts';
    return 'assets';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    return kb < 1024 ? kb.toFixed(1) + ' KB' : (kb / 1024).toFixed(2) + ' MB';
  }

  // Fetch a file through the proxy, with optional progress callback (received, total)
  async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : null;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
    return new Blob(chunks);
  }

  // ---- Core CSS scraping for a list of URLs (integrated) ----
  async function scrapeCssAssets(cssUrls, proxyUrl, onProgress) {
    const totalCss = cssUrls.length;
    let overallBytes = 0;
    const globalAssets = new Map();   // absoluteUrl -> { localName, category, blob }
    const cssFiles = [];              // { filename, content }

    const emit = (overallPct, filePct, detail, currentFile, cssIndex) => {
      if (onProgress) {
        onProgress({
          overallPercent: overallPct,
          filePercent: filePct,
          detail: detail,
          overallBytes: overallBytes,
          currentFile: currentFile,
          cssIndex: cssIndex,
          cssTotal: totalCss
        });
      }
    };

    for (let i = 0; i < cssUrls.length; i++) {
      const url = cssUrls[i];
      const cssFilename = url.substring(url.lastIndexOf('/') + 1) || 'style.css';
      const cssIndex = i + 1;
      const overallPctStart = (i / totalCss) * 100;
      const overallPctEnd   = ((i + 1) / totalCss) * 100;

      // 1. Fetch CSS
      emit(overallPctStart, 0, 'Downloading CSS…', cssFilename, cssIndex);
      let cssBlob;
      try {
        cssBlob = await fetchWithProgress(
          `${proxyUrl}?url=${encodeURIComponent(url)}`,
          (received, total) => {
            const filePct = total ? (received / total) * 20 : 0;
            const overallPct = overallPctStart + (filePct / 100) * (overallPctEnd - overallPctStart);
            emit(overallPct, filePct,
                 `Downloading CSS (${formatBytes(received)} / ${formatBytes(total || 0)})`,
                 cssFilename, cssIndex);
          }
        );
      } catch (e) {
        throw new Error(`Failed to fetch ${url}: ${e.message}`);
      }
      const cssText = await cssBlob.text();
      overallBytes += cssBlob.size;
      emit(overallPctStart, 20, 'Analyzing assets…', cssFilename, cssIndex);

      // 2. Extract asset URLs from CSS
      const urlRegex = /url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/gi;
      const matches = [...cssText.matchAll(urlRegex)];
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const fileAssets = new Map();   // absoluteUrl -> { start, end, originalMatch }

      for (const match of matches) {
        let rawPath = match[1].trim().replace(/^["']|["']$/g, '');
        if (rawPath.startsWith('http://') || rawPath.startsWith('https://') || rawPath.startsWith('//')) continue;
        try {
          const absoluteUrl = new URL(rawPath, baseUrl).href;
          if (!fileAssets.has(absoluteUrl)) {
            if (!globalAssets.has(absoluteUrl)) {
              let filename = absoluteUrl.substring(absoluteUrl.lastIndexOf('/') + 1);
              const qIdx = filename.indexOf('?');
              if (qIdx !== -1) filename = filename.substring(0, qIdx);
              if (!filename) filename = 'asset';
              let unique = filename;
              const usedNames = new Set(Array.from(globalAssets.values()).map(v => v.localName));
              let counter = 1;
              while (usedNames.has(unique)) {
                const dot = filename.lastIndexOf('.');
                unique = dot !== -1
                  ? filename.substring(0, dot) + `_${counter}` + filename.substring(dot)
                  : filename + `_${counter}`;
                counter++;
              }
              globalAssets.set(absoluteUrl, {
                localName: unique,
                category: getCategory(filename),
                blob: null
              });
            }
            fileAssets.set(absoluteUrl, {
              start: match.index,
              end: match.index + match[0].length,
              originalMatch: match[0]
            });
          }
        } catch (e) { /* ignore */ }
      }

      // 3. Download assets for this CSS (only new ones)
      const assetsNeeded = Array.from(fileAssets.keys()).filter(
        absUrl => !globalAssets.get(absUrl).blob
      );
      const totalAssets = assetsNeeded.length;

      if (totalAssets > 0) {
        const assetProgressStart = 20;
        const assetProgressEnd   = 90;
        const range = assetProgressEnd - assetProgressStart;

        for (let j = 0; j < assetsNeeded.length; j++) {
          const assetUrl = assetsNeeded[j];
          const info = globalAssets.get(assetUrl);
          const detail = `Asset ${j+1}/${totalAssets}: ${info.localName}`;

          const filePctStart = assetProgressStart + (range * (j / totalAssets));
          emit(overallPctStart + (filePctStart / 100) * (overallPctEnd - overallPctStart),
               filePctStart, detail, cssFilename, cssIndex);

          try {
            const assetBlob = await fetchWithProgress(
              `${proxyUrl}?url=${encodeURIComponent(assetUrl)}`,
              (received, total) => {
                const step = range / totalAssets;
                const fraction = total ? received / total : 0;
                const filePct = filePctStart + fraction * step;
                const overallPct = overallPctStart + (filePct / 100) * (overallPctEnd - overallPctStart);
                emit(overallPct, filePct, detail, cssFilename, cssIndex);
              }
            );
            overallBytes += assetBlob.size;
            globalAssets.get(assetUrl).blob = assetBlob;
            const filePctEnd = assetProgressStart + (range * ((j + 1) / totalAssets));
            const overallPctEndAsset = overallPctStart + (filePctEnd / 100) * (overallPctEnd - overallPctStart);
            emit(overallPctEndAsset, filePctEnd, detail, cssFilename, cssIndex);
          } catch (e) {
            console.warn(`Skipped ${assetUrl}: ${e.message}`);
            const filePctEnd = assetProgressStart + (range * ((j + 1) / totalAssets));
            const overallPctEndAsset = overallPctStart + (filePctEnd / 100) * (overallPctEnd - overallPctStart);
            emit(overallPctEndAsset, filePctEnd, `Skipped ${info.localName}`, cssFilename, cssIndex);
          }
        }
      }

      // 4. Rewrite CSS with local paths
      emit(overallPctStart, 90, 'Rewriting CSS…', cssFilename, cssIndex);
      let rewritten = cssText;
      const replacements = [];
      for (const [absUrl, { start, end, originalMatch }] of fileAssets) {
        const info = globalAssets.get(absUrl);
        if (!info.blob) continue;
        const localPath = `${info.category}/${info.localName}`;
        replacements.push({ start, end, originalMatch, localPath });
      }
      replacements.sort((a, b) => b.start - a.start);
      for (const { start, end, originalMatch, localPath } of replacements) {
        const hasQuotes = /url\(\s*["']/.test(originalMatch);
        const newUrl = hasQuotes ? `url("${localPath}")` : `url(${localPath})`;
        rewritten = rewritten.substring(0, start) + newUrl + rewritten.substring(end);
      }

      // Generate unique zip filename
      let zipCssName = url.substring(url.lastIndexOf('/') + 1) || 'style.css';
      const qIdx = zipCssName.indexOf('?');
      if (qIdx !== -1) zipCssName = zipCssName.substring(0, qIdx);
      const usedNames = new Set(cssFiles.map(f => f.filename));
      let uniqueCssName = zipCssName;
      let counter = 1;
      while (usedNames.has(uniqueCssName)) {
        const dot = zipCssName.lastIndexOf('.');
        uniqueCssName = dot !== -1
          ? zipCssName.substring(0, dot) + `_${counter}` + zipCssName.substring(dot)
          : zipCssName + `_${counter}`;
        counter++;
      }
      cssFiles.push({ filename: uniqueCssName, content: rewritten });

      emit(overallPctEnd, 100, 'Done', cssFilename, cssIndex);
    }

    // 5. Build CSS zip
    emit(95, 0, 'Building CSS zip…', '', totalCss);
    const zip = new JSZip();
    for (const { filename, content } of cssFiles) {
      zip.file(filename, content);
    }
    for (const [absUrl, { localName, category, blob }] of globalAssets) {
      if (blob) zip.folder(category).file(localName, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    emit(100, 100, 'CSS zip ready', '', totalCss);
    return zipBlob;
  }

  // -------- Public Web Scraper --------
  async function scrape(pageUrl, options = {}) {
    const {
      apiBase = 'https://fetch-css.vercel.app/api/web-scraper',
      onProgress = null
    } = options;

    const emit = (phase, percent, detail) => {
      if (onProgress) onProgress({ phase, percent, detail });
    };

    // 1. Inspect page via unified API
    emit('fetching', 0, 'Inspecting page…');
    const inspectResp = await fetch(`${apiBase}?action=inspect&url=${encodeURIComponent(pageUrl)}`);
    if (!inspectResp.ok) throw new Error('Failed to inspect page');
    const { htmlAttrs, bodyAttrs, cleanedHead, cleanedBody } = await inspectResp.json();

    // 2. Build DOM for collection
    emit('parsing', 5, 'Collecting assets…');
    const parser = new DOMParser();
    const rawDoc = `<!DOCTYPE html>${htmlAttrs}<head>${cleanedHead}</head>${bodyAttrs}${cleanedBody}</body></html>`;
    const doc = parser.parseFromString(rawDoc, 'text/html');

    // Collect CSS and image absolute URLs
    const cssUrls = [];
    doc.querySelectorAll('link[rel="stylesheet"], link[as="style"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href) {
        try { cssUrls.push(new URL(href, pageUrl).href); } catch {}
      }
    });
    const imgUrls = [];
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (src) {
        try { imgUrls.push(new URL(src, pageUrl).href); } catch {}
      }
    });
    const uniqueCss = [...new Set(cssUrls)];
    const uniqueImg = [...new Set(imgUrls)];

    // 3. Rewrite HTML for local paths
    doc.querySelectorAll('link[rel="stylesheet"], link[as="style"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href) {
        const filename = (href.split('/').pop() || 'style.css').split('?')[0];
        link.setAttribute('href', 'css/' + filename);
      }
    });
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (src) {
        const filename = (src.split('/').pop() || 'image').split('?')[0];
        img.setAttribute('src', 'images/' + filename);
      }
    });
    const finalHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

    // 4. Scrape CSS assets (integrated)
    emit('css', 10, 'Downloading CSS and assets…');
    const cssZipBlob = await scrapeCssAssets(uniqueCss, apiBase, (cssInfo) => {
      const pct = 10 + (cssInfo.overallPercent * 0.7);
      emit('css', Math.min(pct, 80), cssInfo.detail || '');
    });

    // 5. Reorganise zip
    const zip = await JSZip.loadAsync(cssZipBlob);
    const cssFolder = zip.folder('css');

    // Move CSS files to css/
    for (const url of uniqueCss) {
      const filename = (url.split('/').pop() || 'style.css').split('?')[0];
      const file = zip.file(filename);
      if (file) {
        const content = await file.async('string');
        cssFolder.file(filename, content);
        zip.remove(filename);
      }
    }

    // Move asset folders into css/
    for (const folder of ['images', 'fonts', 'assets']) {
      const files = zip.file(new RegExp(`^${folder}/`));
      if (files.length > 0) {
        const target = cssFolder.folder(folder);
        for (const file of files) {
          const blob = await file.async('blob');
          const relativePath = file.name.substring(folder.length + 1);
          target.file(relativePath, blob);
          zip.remove(file.name);
        }
      }
    }

    // 6. Download page images
    if (uniqueImg.length > 0) {
      emit('images', 80, 'Downloading images…');
      const imagesFolder = zip.folder('images');
      for (let i = 0; i < uniqueImg.length; i++) {
        const imgUrl = uniqueImg[i];
        const filename = (imgUrl.split('/').pop() || 'image').split('?')[0];
        emit('images', 80 + (i + 1) / uniqueImg.length * 15, `Image ${i+1}/${uniqueImg.length}`);
        try {
          const blob = await fetchWithProgress(`${apiBase}?url=${encodeURIComponent(imgUrl)}`);
          imagesFolder.file(filename, blob);
        } catch (e) { console.warn('Image failed:', imgUrl, e); }
      }
    }

    // 7. Add final HTML
    zip.file('index.html', finalHtml);

    // 8. Generate final zip
    emit('packing', 95, 'Building archive…');
    const finalBlob = await zip.generateAsync({ type: 'blob' });
    emit('done', 100, 'Complete');
    return finalBlob;
  }

  // -------- Public API --------
  window.WebScraper = { scrape };
})();
