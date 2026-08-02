/**
 * cssScrapper.js – IIFE module
 * Dependency: JSZip (global JSZip)
 * 
 * Usage:
 *   const blob = await CssScraper.scrape('https://.../style.css', { ... });
 *   // or with array for multi
 *   const blob = await CssScraper.scrape(['url1.css', 'url2.css'], { ... });
 * 
 * Options:
 *   proxyUrl   – your CORS proxy endpoint (default: 'https://fetch-css.vercel.app/api/fetch-css')
 *   onProgress – callback(info) where info = {
 *       overallPercent, filePercent, detail, overallBytes,
 *       currentFile, cssIndex, cssTotal,
 *       indeterminate   // true if current operation has unknown total size
 *   }
 */
;(function () {
  'use strict';

  if (typeof JSZip === 'undefined') {
    console.error('CssScraper: JSZip is required. Include it before this script.');
    return;
  }

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

  async function scrape(input, options = {}) {
    const urls = Array.isArray(input) ? input : [input];
    if (urls.length === 0) throw new Error('No URLs provided');

    const {
      proxyUrl = 'https://fetch-css.vercel.app/api/fetch-css',
      onProgress = null
    } = options;

    const totalCss = urls.length;
    let overallBytes = 0;
    const globalAssets = new Map();
    const cssFiles = [];

    const emit = (overallPct, filePct, detail, currentFile, cssIndex, indeterminate = false) => {
      if (onProgress) {
        onProgress({
          overallPercent: overallPct,
          filePercent: filePct,
          detail: detail,
          overallBytes: overallBytes,
          currentFile: currentFile,
          cssIndex: cssIndex,
          cssTotal: totalCss,
          indeterminate: indeterminate
        });
      }
    };

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].trim();
      const cssFilename = url.substring(url.lastIndexOf('/') + 1) || 'style.css';
      const cssIndex = i + 1;
      const overallPctStart = (i / totalCss) * 100;
      const overallPctEnd   = ((i + 1) / totalCss) * 100;

      // --- 1. Fetch CSS ---
      emit(overallPctStart, 0, 'Downloading CSS…', cssFilename, cssIndex, true);   // start indeterminate
      let cssBlob;
      try {
        cssBlob = await fetchWithProgress(
          `${proxyUrl}?url=${encodeURIComponent(url)}`,
          (received, total) => {
            const hasTotal = !!total;
            const filePct = hasTotal ? (received / total) * 20 : 0;
            const overallPct = overallPctStart + (filePct / 100) * (overallPctEnd - overallPctStart);
            emit(overallPct, filePct,
                 `Downloading CSS (${formatBytes(received)} / ${formatBytes(total || 0)})`,
                 cssFilename, cssIndex, !hasTotal);
          }
        );
      } catch (e) {
        throw new Error(`Failed to fetch ${url}: ${e.message}`);
      }
      const cssText = await cssBlob.text();
      overallBytes += cssBlob.size;
      emit(overallPctStart, 20, 'Analyzing assets…', cssFilename, cssIndex, false);

      // --- 2. Extract asset URLs ---
      const urlRegex = /url\(\s*["']?(?!data:)([^"')]+)["']?\s*\)/gi;
      const matches = [...cssText.matchAll(urlRegex)];
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const fileAssets = new Map();

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
        const assetProgressEnd   = 90;
        const range = assetProgressEnd - assetProgressStart;

        for (let j = 0; j < assetsNeeded.length; j++) {
          const assetUrl = assetsNeeded[j];
          const info = globalAssets.get(assetUrl);
          const detail = `Asset ${j+1}/${totalAssets}: ${info.localName}`;
          const filePctStart = assetProgressStart + (range * (j / totalAssets));
          // start of asset – indeterminate true
          emit(overallPctStart + (filePctStart / 100) * (overallPctEnd - overallPctStart),
               filePctStart, detail, cssFilename, cssIndex, true);

          try {
            const assetBlob = await fetchWithProgress(
              `${proxyUrl}?url=${encodeURIComponent(assetUrl)}`,
              (received, total) => {
                const hasTotal = !!total;
                const step = range / totalAssets;
                const fraction = hasTotal ? received / total : 0;
                const filePct = filePctStart + fraction * step;
                const overallPct = overallPctStart + (filePct / 100) * (overallPctEnd - overallPctStart);
                emit(overallPct, filePct, detail, cssFilename, cssIndex, !hasTotal);
              }
            );
            overallBytes += assetBlob.size;
            globalAssets.get(assetUrl).blob = assetBlob;
            const filePctEnd = assetProgressStart + (range * ((j + 1) / totalAssets));
            const overallPctEndAsset = overallPctStart + (filePctEnd / 100) * (overallPctEnd - overallPctStart);
            emit(overallPctEndAsset, filePctEnd, detail, cssFilename, cssIndex, false);
          } catch (e) {
            console.warn(`Skipped ${assetUrl}: ${e.message}`);
            const filePctEnd = assetProgressStart + (range * ((j + 1) / totalAssets));
            const overallPctEndAsset = overallPctStart + (filePctEnd / 100) * (overallPctEnd - overallPctStart);
            emit(overallPctEndAsset, filePctEnd, `Skipped ${info.localName}`, cssFilename, cssIndex, false);
          }
        }
      }

      // --- 4. Rewrite CSS ---
      const filePctRewriting = 90;
      const overallPctRewriting = overallPctStart + (filePctRewriting / 100) * (overallPctEnd - overallPctStart);
      emit(overallPctRewriting, filePctRewriting, 'Rewriting CSS…', cssFilename, cssIndex, false);

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

      emit(overallPctEnd, 100, 'Done', cssFilename, cssIndex, false);
    }

    // --- 5. Build ZIP ---
    const zipStartOverall = 95;
    emit(zipStartOverall, 0, 'Building zip…', '', totalCss, false);
    const zip = new JSZip();
    for (const { filename, content } of cssFiles) {
      zip.file(filename, content);
    }
    for (const [absUrl, { localName, category, blob }] of globalAssets) {
      if (blob) zip.folder(category).file(localName, blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' }, meta => {
      const pct = zipStartOverall + (meta.percent / 100) * (100 - zipStartOverall);
      emit(pct, meta.percent, `Compressing… ${meta.percent.toFixed(0)}%`, '', totalCss, false);
    });
    emit(100, 100, 'Complete', '', totalCss, false);
    return zipBlob;
  }

  window.CssScraper = { scrape };
})();
