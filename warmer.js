#!/usr/bin/env node

/**
 * CDN Cache Warmer
 * Прогрев CDN кеша: краулинг страниц, загрузка всех ассетов (JS, CSS, изображения, шрифты)
 */

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { URL } = require('url');
const { parseStringPromise } = require('xml2js');

// ─── Конфигурация ────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:          process.env.SITE_URL            || 'https://example.com',
  concurrentPages:  parseInt(process.env.CONCURRENT_PAGES)  || 3,
  concurrentAssets: parseInt(process.env.CONCURRENT_ASSETS) || 8,
  delayBetweenPages:  parseInt(process.env.DELAY_PAGES)  || 500,
  delayBetweenAssets: parseInt(process.env.DELAY_ASSETS) || 50,
  requestTimeout:   parseInt(process.env.REQUEST_TIMEOUT) || 15000,
  crawlDepth:       parseInt(process.env.CRAWL_DEPTH) || 2,
  maxPages:         parseInt(process.env.MAX_PAGES)   || 200,
  maxRedirects:     5,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  warmAssetTypes: {
    scripts: true,
    styles:  true,
    images:  true,
    fonts:   true,
    preload: true,
  },
  verbose: process.env.VERBOSE === 'true',
};

// ─── Лог ─────────────────────────────────────────────────────────────────────
const log = {
  info:    (...a) => console.log('\x1b[36m[INFO]\x1b[0m', ...a),
  success: (...a) => console.log('\x1b[32m[OK]\x1b[0m',   ...a),
  warn:    (...a) => console.log('\x1b[33m[WARN]\x1b[0m', ...a),
  error:   (...a) => console.log('\x1b[31m[ERR]\x1b[0m',  ...a),
  debug:   (...a) => CONFIG.verbose && console.log('\x1b[90m[DBG]\x1b[0m', ...a),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

const stats = {
  pages:  { ok: 0, fail: 0, skip: 0 },
  assets: { ok: 0, fail: 0, skip: 0 },
  bytes: 0,
  startTime: Date.now(),
};

// ─── HTTP fetch c gzip + redirect ────────────────────────────────────────────
function fetch(urlStr, options = {}, _redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch { return reject(new Error('Bad URL: ' + urlStr)); }

    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers: {
        'User-Agent':      CONFIG.userAgent,
        'Accept':          options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
        'Cache-Control':   'no-cache',
        ...options.headers,
      },
    };

    const req = lib.request(reqOptions, (res) => {
      // ── Редиректы ──────────────────────────────────────────────────────────
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (_redirects >= CONFIG.maxRedirects) return reject(new Error('Too many redirects'));
        const location = res.headers['location'];
        if (!location) return reject(new Error('Redirect without Location'));
        const nextUrl = new URL(location, urlStr).href;
        log.debug('Redirect ' + res.statusCode + ' -> ' + nextUrl);
        return fetch(nextUrl, options, _redirects + 1).then(resolve, reject);
      }

      // ── Распаковка gzip / deflate / br ────────────────────────────────────
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream;
      if (encoding === 'br') {
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      } else {
        stream = res;
      }

      const chunks = [];
      stream.on('data', c => { chunks.push(c); stats.bytes += c.length; });
      stream.on('end',  () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
      }));
      stream.on('error', reject);
    });

    req.setTimeout(CONFIG.requestTimeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Парсинг HTML ─────────────────────────────────────────────────────────────
function extractFromHtml(html, pageUrl) {
  const base   = new URL(pageUrl);
  const assets = new Set();
  const links  = new Set();

  // Декодируем HTML-сущности в URL (&amp; → &, &lt; → < и т.д.)
  const decodeEntities = (str) => str
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g,  "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  const resolve = (href) => {
    if (!href) return null;
    href = decodeEntities(href.trim());
    if (!href || href.startsWith('data:') || href.startsWith('javascript:') ||
        href.startsWith('mailto:') || href.startsWith('#')) return null;
    try { return new URL(href, base).href; } catch { return null; }
  };

  // ── Внутренние ссылки ──────────────────────────────────────────────────────
  for (const m of html.matchAll(/href=["']([^"'#][^"']*)["']/gi)) {
    const url = resolve(m[1]);
    if (url && isSameDomain(url, base)) links.add(url.split('#')[0].split('?')[0]);
  }

  // ── Scripts ────────────────────────────────────────────────────────────────
  if (CONFIG.warmAssetTypes.scripts) {
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi))
      assets.add(resolve(m[1]));
    // Next.js chunks в __NEXT_DATA__ / манифестах
    for (const m of html.matchAll(/"([^"]*\/_next\/static\/[^"]+\.js)"/g))
      assets.add(resolve(m[1]));
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  if (CONFIG.warmAssetTypes.styles) {
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["'][^>]*>/gi))
      assets.add(resolve(m[1]));
    for (const m of html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi))
      assets.add(resolve(m[1]));
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  if (CONFIG.warmAssetTypes.images) {
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi))
      assets.add(resolve(m[1]));
    for (const m of html.matchAll(/<img[^>]+data-(?:src|lazy|original|lazy-src)=["']([^"']+)["']/gi))
      assets.add(resolve(m[1]));
    for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi))
      m[1].split(',').forEach(s => assets.add(resolve(s.trim().split(' ')[0])));
    for (const m of html.matchAll(/<source[^>]+srcset=["']([^"']+)["']/gi))
      m[1].split(',').forEach(s => assets.add(resolve(s.trim().split(' ')[0])));
    for (const m of html.matchAll(/url\(["']?([^"')]+\.(?:jpe?g|png|webp|gif|svg|avif))["']?\)/gi))
      assets.add(resolve(m[1]));
    // Next.js image URLs в JSON блоках
    for (const m of html.matchAll(/"(\/[^"]+\.(?:jpe?g|png|webp|gif|svg|avif))"/g))
      assets.add(resolve(m[1]));
  }

  // ── Preload ────────────────────────────────────────────────────────────────
  if (CONFIG.warmAssetTypes.preload) {
    for (const m of html.matchAll(/<link[^>]+rel=["']preload["'][^>]+href=["']([^"']+)["']/gi))
      assets.add(resolve(m[1]));
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']preload["']/gi))
      assets.add(resolve(m[1]));
  }

  return {
    assets: [...assets].filter(Boolean),
    links:  [...links].filter(Boolean),
  };
}

// Шрифты из CSS
function extractFontsFromCss(css, cssUrl) {
  const base  = new URL(cssUrl);
  const fonts = new Set();
  for (const m of css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf|eot)[^"')]*?)["']?\)/gi)) {
    try { fonts.add(new URL(m[1], base).href); } catch {}
  }
  return [...fonts];
}

function isSameDomain(url, base) {
  try { return new URL(url).hostname === base.hostname; } catch { return false; }
}

function isHtmlPage(url) {
  const path = url.split('?')[0];
  const ext  = path.split('.').pop().toLowerCase();
  return !['js','css','png','jpg','jpeg','gif','webp','svg','avif','woff','woff2',
    'ttf','otf','eot','ico','pdf','zip','xml','json','map'].includes(ext);
}

// ─── Параллельная очередь ────────────────────────────────────────────────────
async function runQueue(items, concurrency, fn) {
  const queue   = [...items];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

// ─── Прогрев одного ассета ───────────────────────────────────────────────────
async function warmAsset(url) {
  try {
    const res = await fetch(url, { accept: '*/*' });
    if (res.status >= 400) {
      log.warn('Asset ' + res.status + ' ' + url);
      stats.assets.fail++;
    } else {
      log.debug('Asset ' + res.status + ' ' + url);
      stats.assets.ok++;
      if (CONFIG.warmAssetTypes.fonts && /\.css(\?|$)/.test(url)) {
        const fonts = extractFontsFromCss(res.body, url);
        if (fonts.length) log.debug('Fonts from CSS: ' + fonts.length);
        for (const f of fonts) await warmAsset(f);
      }
    }
  } catch (e) {
    log.debug('Asset ERR ' + url + ' — ' + e.message);
    stats.assets.fail++;
  }
  await sleep(CONFIG.delayBetweenAssets);
}

// ─── Краулер ─────────────────────────────────────────────────────────────────
const visited = new Set();

async function warmPage(pageUrl, depth = 0) {
  const cleanUrl = pageUrl.split('#')[0];
  if (visited.has(cleanUrl))            { stats.pages.skip++; return []; }
  if (visited.size >= CONFIG.maxPages)  { stats.pages.skip++; return []; }
  visited.add(cleanUrl);

  try {
    log.info('[' + visited.size + '/' + CONFIG.maxPages + '] ' + cleanUrl);
    const res = await fetch(cleanUrl);

    if (res.status >= 400) {
      log.warn('Страница ' + res.status + ': ' + cleanUrl);
      stats.pages.fail++;
      return [];
    }

    const ct = res.headers['content-type'] || '';
    if (!ct.includes('html') && !ct.includes('xml')) {
      log.debug('Пропуск (не HTML): ' + ct);
      stats.pages.skip++;
      return [];
    }

    const { assets, links } = extractFromHtml(res.body, cleanUrl);
    log.success('OK [' + res.status + '] — ассеты: ' + assets.length + ', ссылки: ' + links.length);
    stats.pages.ok++;

    await runQueue(assets, CONFIG.concurrentAssets, warmAsset);
    await sleep(CONFIG.delayBetweenPages);
    return depth < CONFIG.crawlDepth ? links : [];
  } catch (e) {
    log.error('Страница ERR ' + cleanUrl + ' — ' + e.message);
    stats.pages.fail++;
    return [];
  }
}

// ─── Sitemap ─────────────────────────────────────────────────────────────────
async function fetchSitemapUrls(baseUrl) {
  const candidates = [
    baseUrl + '/sitemap.xml',
    baseUrl + '/sitemap_index.xml',
    baseUrl + '/sitemap/sitemap.xml',
    baseUrl + '/sitemaps/sitemap.xml',
  ];

  for (const url of candidates) {
    try {
      log.info('Проверяю sitemap: ' + url);
      const res = await fetch(url, { accept: 'application/xml,text/xml,*/*' });
      log.debug('Sitemap статус: ' + res.status + ', content-type: ' + res.headers['content-type']);

      if (res.status !== 200) { log.debug('Пропуск: статус ' + res.status); continue; }

      const trimmed = res.body.trimStart();
      if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<urlset') && !trimmed.startsWith('<sitemapindex')) {
        log.debug('Не XML: ' + trimmed.slice(0, 120));
        continue;
      }

      const parsed = await parseStringPromise(res.body, { explicitArray: true });
      const urls = new Set();

      if (parsed.sitemapindex) {
        const smaps = parsed.sitemapindex.sitemap || [];
        log.info('Sitemap index: ' + smaps.length + ' дочерних карт');
        for (const sm of smaps) {
          const smUrl = sm.loc && sm.loc[0];
          if (!smUrl) continue;
          try {
            log.debug('Загружаю дочерний sitemap: ' + smUrl);
            const r2 = await fetch(smUrl, { accept: 'application/xml,*/*' });
            const p2 = await parseStringPromise(r2.body, { explicitArray: true });
            for (const u of (p2.urlset && p2.urlset.url || [])) {
              if (u.loc && u.loc[0]) urls.add(u.loc[0]);
            }
          } catch (e) { log.debug('Дочерний sitemap ERR: ' + e.message); }
        }
      }

      for (const u of (parsed.urlset && parsed.urlset.url || [])) {
        if (u.loc && u.loc[0]) urls.add(u.loc[0]);
      }

      if (urls.size > 0) {
        log.success('Sitemap: найдено ' + urls.size + ' URL');
        return [...urls];
      }
      log.warn('Sitemap пустой: ' + url);
    } catch (e) {
      log.debug('Sitemap ERR: ' + url + ' — ' + e.message);
    }
  }

  log.warn('Sitemap не найден, стартуем с главной страницы');
  return [baseUrl];
}

// ─── Краулинг ────────────────────────────────────────────────────────────────
async function crawl(startUrls) {
  let frontier = [...new Set(startUrls)];
  let depth = 0;

  while (frontier.length > 0 && visited.size < CONFIG.maxPages && depth <= CONFIG.crawlDepth) {
    log.info('\n--- Глубина ' + depth + ': ' + frontier.length + ' страниц в очереди ---');
    const nextLinks = new Set();

    await runQueue(frontier, CONFIG.concurrentPages, async (url) => {
      const links = await warmPage(url, depth);
      links.forEach(l => { if (!visited.has(l) && isHtmlPage(l)) nextLinks.add(l); });
    });

    frontier = [...nextLinks].filter(u => !visited.has(u));
    depth++;
  }
}

// ─── Финальный отчёт ─────────────────────────────────────────────────────────
function printReport() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const mb      = (stats.bytes / 1024 / 1024).toFixed(2);
  console.log('\n' + '='.repeat(52));
  console.log('           CDN WARMER — ОТЧЁТ');
  console.log('='.repeat(52));
  console.log('  Страницы:  OK ' + stats.pages.ok + '   FAIL ' + stats.pages.fail + '   SKIP ' + stats.pages.skip);
  console.log('  Ассеты:    OK ' + stats.assets.ok + '   FAIL ' + stats.assets.fail + '   SKIP ' + stats.assets.skip);
  console.log('  Трафик:    ' + mb + ' МБ');
  console.log('  Время:     ' + elapsed + ' сек');
  console.log('='.repeat(52) + '\n');
}

// ─── Точка входа ─────────────────────────────────────────────────────────────
(async () => {
  console.log('\n CDN Cache Warmer\n');
  log.info('Сайт:          ' + CONFIG.baseUrl);
  log.info('Параллельность: ' + CONFIG.concurrentPages + ' страниц / ' + CONFIG.concurrentAssets + ' ассетов');
  log.info('Глубина: ' + CONFIG.crawlDepth + ',  макс. страниц: ' + CONFIG.maxPages + '\n');

  try {
    const base    = new URL(CONFIG.baseUrl);
    const allUrls = await fetchSitemapUrls(CONFIG.baseUrl);
    const filtered = allUrls.filter(u => {
      try { return new URL(u).hostname === base.hostname && isHtmlPage(u); } catch { return false; }
    });
    await crawl(filtered.length ? filtered : [CONFIG.baseUrl]);
  } catch (e) {
    log.error('Критическая ошибка: ' + e.message);
  } finally {
    printReport();
  }
})();