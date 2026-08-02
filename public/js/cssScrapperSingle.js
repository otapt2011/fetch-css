/**
 * cssScrapperSingle.js  (IIFE)
 * Dependency: JSZip (global JSZip)
 * Usage:
 *   const blob = await CssScraperSingle.scrape(url, {
 *     proxyUrl: 'https://fetch-css.vercel.app/api/fetch-css',
 *     onProgress: (info) => console.log(info)
 *   });
 *   // info = { overallPercent, filePercent, detail, overallBytes, currentFile, cssIndex, cssTotal }
 */
;(function () {
  'use strict';

  if (typeof JSZip === 'undefined') {
    console.error('CssScraperSingle: JSZip is required. Include it before this script.');
    return;
  }

  const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','tiff']);
  const FONT_EXTS = new Set(['woff','woff2','ttf','otf','eot']);

  function getCategory(filename) {
    const ext = filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'images';
    if (FONT_EXTS.has(ext)) return 'fonts';
    return 'assets';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    return kb < 1024 ? kb.toFixed(1) + ' KB' : (kb / 1024).toFixed(2) + ' MB';
  }

  // Streaming fetch helper – calls onProgress(received, total)
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

  async function scrapeSingle(url, options = {}) {
    const {
      proxyUrl = 'https://fetch-css.vercel.app/api/fetch-css',
      onProgress = null
    } = options;

    const emit = (info) => {
      if (onProgress) onProgress(info);
    };

    // State
    let totalBytes = 0;
    const globalAssets = new Map(); // absoluteUrl -> { localName, category, blob }

    const cssFilename = url.substring(url.lastIndexOf('/') + 1) || 'style.css';

    // --- 1. Fetch CSS ---
    emit({ overallPercent: 0, filePercent: 0, detail: 'Downloading CSS…',
           overallBytes: 0, currentFile: cssFilename, cssIndex: 1, cssTotal: 1 });
    const cssBlob = await fetchWithProgress(
      `${proxyUrl}?url=${encodeURIComponent(url)}`,
      (received, total) => {
        const pct = total ? (received / total) * 20 : 0;
        emit({ overallPercent: 0, filePercent: pct,
               detail: `Downloading CSS (${formatBytes(received)} / ${formatBytes(total||0)})`,
               overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });
      }
    );
    const cssText = await cssBlob.text();
    totalBytes += cssBlob.size;
    emit({ overallPercent: 0, filePercent: 20, detail: 'Analyzing assets…',
           overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });

    // --- 2. Extract assets ---
    const urlRegex = /url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/gi;
    const matches = [...cssText.matchAll(urlRegex)];
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const fileAssets = new Map(); // absoluteUrl -> { start, end, originalMatch }

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

    // --- 3. Download assets ---
    const assetsNeeded = Array.from(fileAssets.keys()).filter(
      absUrl => !globalAssets.get(absUrl).blob
    );
    const totalAssets = assetsNeeded.length;

    if (totalAssets > 0) {
      const assetProgressStart = 20;
      const assetProgressEnd = 90;
      const range = assetProgressEnd - assetProgressStart;

      for (let j = 0; j < assetsNeeded.length; j++) {
        const assetUrl = assetsNeeded[j];
        const info = globalAssets.get(assetUrl);
        const detail = `Asset ${j+1}/${totalAssets}: ${info.localName}`;
        emit({ overallPercent: 0,
               filePercent: assetProgressStart + (range * (j / totalAssets)),
               detail, overallBytes: totalBytes, currentFile: cssFilename,
               cssIndex:1, cssTotal:1 });

        try {
          const assetBlob = await fetchWithProgress(
            `${proxyUrl}?url=${encodeURIComponent(assetUrl)}`,
            (received, total) => {
              const step = range / totalAssets;
              const fraction = total ? received / total : 0;
              const start = assetProgressStart + step * j;
              const pct = start + fraction * step;
              emit({ overallPercent: 0, filePercent: pct, detail,
                     overallBytes: totalBytes + received, currentFile: cssFilename,
                     cssIndex:1, cssTotal:1 });
            }
          );
          totalBytes += assetBlob.size;
          globalAssets.get(assetUrl).blob = assetBlob;
          emit({ overallPercent: 0, filePercent: assetProgressStart + (range * ((j+1)/totalAssets)),
                 detail, overallBytes: totalBytes, currentFile: cssFilename,
                 cssIndex:1, cssTotal:1 });
        } catch (e) {
          console.warn(`Skipped ${assetUrl}: ${e.message}`);
          emit({ overallPercent: 0, filePercent: assetProgressStart + (range * ((j+1)/totalAssets)),
                 detail: `Skipped ${info.localName}`, overallBytes: totalBytes,
                 currentFile: cssFilename, cssIndex:1, cssTotal:1 });
        }
      }
    }

    // --- 4. Rewrite CSS ---
    emit({ overallPercent: 0, filePercent: 90, detail: 'Rewriting CSS…',
           overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });
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

    // --- 5. Build ZIP ---
    emit({ overallPercent: 0, filePercent: 95, detail: 'Building zip…',
           overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });
    const zip = new JSZip();
    const parsedUrl = new URL(url);
    let zipCssName = parsedUrl.pathname.substring(parsedUrl.pathname.lastIndexOf('/') + 1);
    if (!zipCssName) zipCssName = 'style.css';
    const qIdx = zipCssName.indexOf('?');
    if (qIdx !== -1) zipCssName = zipCssName.substring(0, qIdx);
    zip.file(zipCssName, rewritten);
    for (const [absUrl, { localName, category, blob }] of globalAssets) {
      if (blob) zip.folder(category).file(localName, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' }, meta => {
      emit({ overallPercent: 0, filePercent: 95 + (meta.percent/100)*5,
             detail: `Compressing… ${meta.percent.toFixed(0)}%`,
             overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });
    });
    emit({ overallPercent: 100, filePercent: 100, detail: 'Complete',
           overallBytes: totalBytes, currentFile: cssFilename, cssIndex:1, cssTotal:1 });
    return zipBlob;
  }

  // Public API
  window.CssScraperSingle = { scrape: scrapeSingle };
})();
