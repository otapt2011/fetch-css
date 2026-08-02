/**
 * cssScrapperMulti.js  (IIFE)
 * Dependency: JSZip (global JSZip)
 * Usage:
 *   const blob = await CssScraperMulti.scrape(urls, {
 *     proxyUrl: 'https://fetch-css.vercel.app/api/fetch-css',
 *     onProgress: (info) => console.log(info)
 *   });
 *   // info = { overallPercent, filePercent, detail, overallBytes,
 *   //          currentFile, cssIndex, cssTotal }
 */
;(function () {
  'use strict';

  if (typeof JSZip === 'undefined') {
    console.error('CssScraperMulti: JSZip is required. Include it before this script.');
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

  async function scrapeMulti(urls, options = {}) {
    const {
      proxyUrl = 'https://fetch-css.vercel.app/api/fetch-css',
      onProgress = null
    } = options;

    const emit = (info) => {
      if (onProgress) onProgress(info);
    };

    const totalCss = urls.length;
    let overallBytes = 0;
    const globalAssets = new Map(); // absoluteUrl -> { localName, category, blob }
    const cssFiles = []; // { filename, content }

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].trim();
      const cssFilename = url.substring(url.lastIndexOf('/') + 1) || 'style.css';
      const cssIndex = i + 1;
      const overallPct = ((i) / totalCss) * 100; // 0% at start of each file

      // --- 1. Fetch CSS ---
      emit({ overallPercent: overallPct, filePercent: 0, detail: 'Downloading CSS…',
             overallBytes, currentFile: cssFilename, cssIndex, cssTotal: totalCss });
      let cssBlob;
      try {
        cssBlob = await fetchWithProgress(
          `${proxyUrl}?url=${encodeURIComponent(url)}`,
          (received, total) => {
            const pct = total ? (received / total) * 20 : 0;
            emit({ overallPercent: overallPct, filePercent: pct,
                   detail: `Downloading CSS (${formatBytes(received)} / ${formatBytes(total||0)})`,
                   overallBytes, currentFile: cssFilename, cssIndex, cssTotal: totalCss });
          }
        );
      } catch (e) {
        throw new Error(`Failed to fetch ${url}: ${e.message}`);
      }
      const cssText = await cssBlob.text();
      overallBytes += cssBlob.size;
      emit({ overallPercent: overallPct, filePercent: 20, detail: 'Analyzing assets…',
             overallBytes, currentFile: cssFilename, cssIndex, cssTotal: totalCss });

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
          emit({ overallPercent: overallPct,
                 filePercent: assetProgressStart + (range * (j / totalAssets)),
                 detail, overallBytes, currentFile: cssFilename,
                 cssIndex, cssTotal: totalCss });

          try {
            const assetBlob = await fetchWithProgress(
              `${proxyUrl}?url=${encodeURIComponent(assetUrl)}`,
              (received, total) => {
                const step = range / totalAssets;
                const fraction = total ? received / total : 0;
                const start = assetProgressStart + step * j;
                const pct = start + fraction * step;
                emit({ overallPercent: overallPct, filePercent: pct, detail,
                       overallBytes: overallBytes + received, currentFile: cssFilename,
                       cssIndex, cssTotal: totalCss });
              }
            );
            overallBytes += assetBlob.size;
            globalAssets.get(assetUrl).blob = assetBlob;
            emit({ overallPercent: overallPct,
                   filePercent: assetProgressStart + (range * ((j+1)/totalAssets)),
                   detail, overallBytes, currentFile: cssFilename,
                   cssIndex, cssTotal: totalCss });
          } catch (e) {
            console.warn(`Skipped ${assetUrl}: ${e.message}`);
            emit({ overallPercent: overallPct,
                   filePercent: assetProgressStart + (range * ((j+1)/totalAssets)),
                   detail: `Skipped ${info.localName}`, overallBytes,
                   currentFile: cssFilename, cssIndex, cssTotal: totalCss });
          }
        }
      }

      // --- 4. Rewrite CSS ---
      emit({ overallPercent: overallPct, filePercent: 90, detail: 'Rewriting CSS…',
             overallBytes, currentFile: cssFilename, cssIndex, cssTotal: totalCss });
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

      // Generate unique CSS filename
      const parsedUrl = new URL(url);
      let zipCssName = parsedUrl.pathname.substring(parsedUrl.pathname.lastIndexOf('/') + 1);
      if (!zipCssName) zipCssName = 'style.css';
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

      // File done (100% for this file)
      emit({ overallPercent: ((cssIndex) / totalCss) * 100, filePercent: 100,
             detail: 'Done', overallBytes, currentFile: cssFilename,
             cssIndex, cssTotal: totalCss });
    }

    // --- 5. Build ZIP ---
    const zipStartOverall = 95;
    emit({ overallPercent: zipStartOverall, filePercent: 0, detail: 'Building zip…',
           overallBytes, currentFile: '', cssIndex: totalCss, cssTotal: totalCss });
    const zip = new JSZip();
    for (const { filename, content } of cssFiles) {
      zip.file(filename, content);
    }
    for (const [absUrl, { localName, category, blob }] of globalAssets) {
      if (blob) zip.folder(category).file(localName, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' }, meta => {
      const pct = zipStartOverall + (meta.percent / 100) * (100 - zipStartOverall);
      emit({ overallPercent: pct, filePercent: meta.percent,
             detail: `Compressing… ${meta.percent.toFixed(0)}%`,
             overallBytes, currentFile: '', cssIndex: totalCss, cssTotal: totalCss });
    });
    emit({ overallPercent: 100, filePercent: 100, detail: 'Complete',
           overallBytes, currentFile: '', cssIndex: totalCss, cssTotal: totalCss });
    return zipBlob;
  }

  window.CssScraperMulti = { scrape: scrapeMulti };
})();
