#!/usr/bin/env node

/**
 * CDN Cache Warmer
 * Прогрев CDN кеша: загрузка страниц из cache-warmup.xml и всех ассетов (JS, CSS, изображения, шрифты)
 */

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const fs    = require('fs');
const { URL } = require('url');
const { parseStringPromise } = require('xml2js');

loadEnvFile();

// ─── Конфигурация ────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:          process.env.SITE_URL            || 'https://example.com',
  concurrentPages:  parseInt(process.env.CONCURRENT_PAGES)  || 3,
  concurrentAssets: parseInt(process.env.CONCURRENT_ASSETS) || 8,
  delayBetweenPages:  parseInt(process.env.DELAY_PAGES)  || 500,
  delayBetweenAssets: parseInt(process.env.DELAY_ASSETS) || 50,
  requestTimeout:   parseInt(process.env.REQUEST_TIMEOUT) || 15000,
  maxPages:         parseInt(process.env.MAX_PAGES)   || 200,
  maxRedirects:     5,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mobileUserAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  warmMobileHtml: process.env.WARM_MOBILE_HTML !== 'false',
  browserWarm: process.env.BROWSER_WARM !== 'false',
  browserScrollStep: parseInt(process.env.BROWSER_SCROLL_STEP) || 700,
  browserScrollDelay: parseInt(process.env.BROWSER_SCROLL_DELAY) || 300,
  browserMaxScrolls: parseInt(process.env.BROWSER_MAX_SCROLLS) || 80,
  warmAssetTypes: {
    scripts: true,
    styles:  true,
    images:  true,
    fonts:   true,
    preload: true,
  },
  verbose: process.env.VERBOSE === 'true',
  neon: {
    databaseUrl: process.env.DATABASE_URL || '',
    projectId:   process.env.PROJECT_ID || '',
    apiKey:      process.env.NEON_API_KEY || '',
    endpointId:  process.env.NEON_ENDPOINT_ID || '',
    wakeDelay:   parseInt(process.env.NEON_WAKE_DELAY) || 2000,
  },
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

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

function loadEnvFile(path = '.env') {
  if (!fs.existsSync(path)) return;

  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const stats = {
  pages:  { ok: 0, fail: 0, skip: 0 },
  assets: { ok: 0, fail: 0, skip: 0 },
  bytes: 0,
  startTime: Date.now(),
};

let browserInstancePromise = null;
const warmedAssets = new Set();
const announcedImages = new Set();

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

function neonRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'console.neon.tech',
      port: 443,
      path: '/api/v2' + path,
      method: options.method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.neon.apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}

        if (res.statusCode >= 400) {
          const message = json && json.message ? json.message : body || ('HTTP ' + res.statusCode);
          reject(new Error('Neon API ' + res.statusCode + ': ' + message));
          return;
        }

        resolve({ status: res.statusCode, body: json });
      });
    });

    req.setTimeout(CONFIG.requestTimeout, () => { req.destroy(); reject(new Error('Neon API timeout')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchNeonEndpoints() {
  const res = await neonRequest('/projects/' + encodeURIComponent(CONFIG.neon.projectId) + '/endpoints');
  return res.body && Array.isArray(res.body.endpoints) ? res.body.endpoints : [];
}

function selectNeonEndpoint(endpoints) {
  if (CONFIG.neon.endpointId) {
    return endpoints.find(e => e.id === CONFIG.neon.endpointId);
  }

  let dbHost = '';
  try { dbHost = new URL(CONFIG.neon.databaseUrl).hostname; } catch {}

  if (dbHost) {
    const byHost = endpoints.find(e => e.host === dbHost || e.host === dbHost.replace('-pooler.', '.'));
    if (byHost) return byHost;
  }

  return endpoints.length === 1 ? endpoints[0] : null;
}

function isNeonEndpointAwake(endpoint) {
  const state = String(endpoint.current_state || endpoint.state || '').toLowerCase();
  return ['active', 'ready'].includes(state);
}

async function ensureNeonDatabaseAwake() {
  const missing = [];
  if (!CONFIG.neon.projectId) missing.push('PROJECT_ID');
  if (!CONFIG.neon.apiKey) missing.push('NEON_API_KEY');
  if (!CONFIG.neon.databaseUrl) missing.push('DATABASE_URL');

  if (missing.length) {
    throw new Error('Neon check невозможен: missing ' + missing.join(', '));
  }

  log.info('Проверяю состояние Neon database...');
  const endpoints = await fetchNeonEndpoints();
  const endpoint = selectNeonEndpoint(endpoints);

  if (!endpoint) {
    throw new Error('Не удалось выбрать Neon endpoint. Укажите NEON_ENDPOINT_ID или проверьте DATABASE_URL.');
  }

  const state = endpoint.current_state || endpoint.state || 'unknown';
  log.info('Neon endpoint: ' + endpoint.id + ', состояние: ' + state);

  if (isNeonEndpointAwake(endpoint)) {
    log.success('Neon database уже активна');
    return;
  }

  log.info('Neon database спит, отправляю команду start...');
  await neonRequest(
      '/projects/' + encodeURIComponent(CONFIG.neon.projectId) +
      '/endpoints/' + encodeURIComponent(endpoint.id) +
      '/start',
      { method: 'POST' }
  );

  await sleep(CONFIG.neon.wakeDelay);

  const updatedEndpoints = await fetchNeonEndpoints();
  const updatedEndpoint = selectNeonEndpoint(updatedEndpoints);
  const updatedState = updatedEndpoint && (updatedEndpoint.current_state || updatedEndpoint.state || 'unknown');

  if (!updatedEndpoint || !isNeonEndpointAwake(updatedEndpoint)) {
    throw new Error('Neon database не проснулась через ' + CONFIG.neon.wakeDelay + ' мс. Текущее состояние: ' + (updatedState || 'unknown'));
  }

  log.success('Neon database активна, продолжаю прогрев кеша');
}

// ─── Парсинг HTML ─────────────────────────────────────────────────────────────
function extractFromHtml(html, pageUrl) {
  const base   = new URL(pageUrl);
  const assets = new Set();

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

  const expandedAssets = new Set([...assets].filter(Boolean));
  for (const assetUrl of expandedAssets) {
    try {
      const parsed = new URL(assetUrl);
      if (parsed.pathname === '/_next/image' && parsed.searchParams.has('url')) {
        expandedAssets.add(new URL(parsed.searchParams.get('url'), base).href);
      }
    } catch {}
  }

  return {
    assets: [...expandedAssets],
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

function getAssetAccept(url) {
  const lower = url.split('?')[0].toLowerCase();

  if (isImageAsset(url)) {
    return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
  }

  if (/\.css$/.test(lower)) {
    return 'text/css,*/*;q=0.1';
  }

  if (/\.js$/.test(lower)) {
    return '*/*';
  }

  if (/\.(?:woff2?|ttf|otf|eot)$/.test(lower)) {
    return '*/*';
  }

  return '*/*';
}

function isImageAsset(url) {
  const lower = url.split('?')[0].toLowerCase();
  return lower.includes('/_next/image') || /\.(?:jpe?g|png|webp|gif|svg|avif|ico)$/.test(lower);
}

function getAssetWarmRequests(url) {
  if (!isImageAsset(url)) {
    return [{ accept: getAssetAccept(url) }];
  }

  return [
    {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      headers: { 'User-Agent': CONFIG.userAgent },
    },
    {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' },
    },
    {
      accept: 'image/webp,image/*,*/*;q=0.8',
      headers: { 'User-Agent': CONFIG.mobileUserAgent },
    },
  ];
}

async function collectBrowserAssets(pageUrl, userAgent) {
  if (!CONFIG.browserWarm || !CONFIG.warmAssetTypes.images) return [];

  const playwright = loadPlaywright();
  if (!playwright) {
    log.warn('Browser warm skipped: install playwright to trigger lazy-loaded images');
    return [];
  }

  if (!browserInstancePromise) {
    browserInstancePromise = playwright.chromium.launch({
      headless: true,
      executablePath: playwright.chromium.executablePath(),
    }).catch((e) => {
      browserInstancePromise = null;
      throw e;
    });
  }

  const browser = await browserInstancePromise;
  const context = await browser.newContext({
    userAgent,
    viewport: userAgent === CONFIG.mobileUserAgent
        ? { width: 390, height: 844, isMobile: true }
        : { width: 1440, height: 1200 },
  });
  const page = await context.newPage();

  const requestedImages = new Set();
  page.on('requestfinished', (request) => {
    if (request.resourceType() === 'image') requestedImages.add(request.url());
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: CONFIG.requestTimeout });

    let previousY = -1;
    for (let i = 0; i < CONFIG.browserMaxScrolls; i++) {
      const currentY = await page.evaluate((step) => {
        window.scrollBy(0, step);
        return window.scrollY;
      }, CONFIG.browserScrollStep);
      await page.waitForTimeout(CONFIG.browserScrollDelay);
      if (currentY === previousY) break;
      previousY = currentY;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState('networkidle', { timeout: CONFIG.requestTimeout }).catch(() => {});

    const browserUrls = await page.evaluate(() => {
      const urls = new Set();

      for (const img of document.images) {
        if (img.currentSrc) urls.add(img.currentSrc);
        if (img.src) urls.add(img.src);
        if (img.srcset) {
          for (const candidate of img.srcset.split(',')) {
            const src = candidate.trim().split(/\s+/)[0];
            if (src) urls.add(src);
          }
        }
      }

      for (const source of document.querySelectorAll('source[srcset]')) {
        for (const candidate of source.srcset.split(',')) {
          const src = candidate.trim().split(/\s+/)[0];
          if (src) urls.add(src);
        }
      }

      for (const element of document.querySelectorAll('*')) {
        const bg = getComputedStyle(element).backgroundImage;
        if (!bg || bg === 'none') continue;
        for (const match of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          if (match[1] && !match[1].startsWith('data:')) urls.add(match[1]);
        }
      }

      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.initiatorType === 'img' || /\.(?:jpe?g|png|webp|gif|svg|avif|ico)(?:\?|$)/i.test(entry.name)) {
          urls.add(entry.name);
        }
      }

      return [...urls];
    });

    const normalized = new Set([...requestedImages]);
    browserUrls.forEach((url) => {
      try { normalized.add(new URL(url, pageUrl).href); } catch {}
    });

    return [...normalized].filter(url => !url.startsWith('data:'));
  } finally {
    await context.close();
  }
}

async function closeBrowser() {
  if (!browserInstancePromise) return;

  try {
    const browser = await browserInstancePromise;
    await browser.close();
  } catch (e) {
    log.debug('Browser close skipped: ' + e.message);
  } finally {
    browserInstancePromise = null;
  }
}

function isHtmlPage(url) {
  const path = url.split('?')[0];
  const ext  = path.split('.').pop().toLowerCase();
  return !['js','css','png','jpg','jpeg','gif','webp','svg','avif','woff','woff2',
    'ttf','otf','eot','ico','pdf','zip','xml','json','map','webmanifest'].includes(ext);
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
  if (warmedAssets.has(url)) {
    stats.assets.skip++;
    log.debug('Asset SKIP duplicate ' + url);
    return;
  }

  warmedAssets.add(url);

  for (const requestOptions of getAssetWarmRequests(url)) {
    try {
      const res = await fetch(url, requestOptions);
      if (res.status >= 400) {
        log.warn('Asset ' + res.status + ' ' + url);
        stats.assets.fail++;
      } else {
        log.debug('Asset ' + res.status + ' ' + url + ' [' + requestOptions.accept + ']');
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
  }
  await sleep(CONFIG.delayBetweenAssets);
}

function logPageImages(pageUrl, assets) {
  const images = [...assets].filter(url =>
      isImageAsset(url) && !warmedAssets.has(url) && !announcedImages.has(url)
  );

  if (!images.length) {
    log.info('Изображения: новых URL нет');
    return;
  }

  log.info('Изображения для прогрева: ' + images.length + ' (' + pageUrl + ')');
  images.forEach((url, index) => {
    announcedImages.add(url);
    console.log('  IMG ' + String(index + 1).padStart(3, ' ') + ' ' + url);
  });
}

// ─── Прогрев страниц ─────────────────────────────────────────────────────────
const visited = new Set();

async function warmPage(pageUrl) {
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

    const assets = new Set();
    const extracted = extractFromHtml(res.body, cleanUrl);
    extracted.assets.forEach(a => assets.add(a));

    if (CONFIG.warmMobileHtml) {
      try {
        const mobileRes = await fetch(cleanUrl, {
          headers: { 'User-Agent': CONFIG.mobileUserAgent },
        });
        const mobileCt = mobileRes.headers['content-type'] || '';
        if (mobileRes.status < 400 && (mobileCt.includes('html') || mobileCt.includes('xml'))) {
          const mobileExtracted = extractFromHtml(mobileRes.body, cleanUrl);
          mobileExtracted.assets.forEach(a => assets.add(a));
        }
      } catch (e) {
        log.debug('Mobile HTML ERR ' + cleanUrl + ' — ' + e.message);
      }
    }

    try {
      const browserAssets = await collectBrowserAssets(cleanUrl, CONFIG.userAgent);
      browserAssets.forEach(a => assets.add(a));
      if (browserAssets.length) log.debug('Browser assets: ' + browserAssets.length);
    } catch (e) {
      log.warn('Browser warm ERR ' + cleanUrl + ' — ' + e.message);
    }

    if (CONFIG.warmMobileHtml) {
      try {
        const mobileBrowserAssets = await collectBrowserAssets(cleanUrl, CONFIG.mobileUserAgent);
        mobileBrowserAssets.forEach(a => assets.add(a));
        if (mobileBrowserAssets.length) log.debug('Mobile browser assets: ' + mobileBrowserAssets.length);
      } catch (e) {
        log.warn('Mobile browser warm ERR ' + cleanUrl + ' — ' + e.message);
      }
    }

    log.success('OK [' + res.status + '] — ассеты: ' + assets.size);
    logPageImages(cleanUrl, assets);
    stats.pages.ok++;

    await runQueue([...assets], CONFIG.concurrentAssets, warmAsset);
    await sleep(CONFIG.delayBetweenPages);
    return [];
  } catch (e) {
    log.error('Страница ERR ' + cleanUrl + ' — ' + e.message);
    stats.pages.fail++;
    return [];
  }
}

// ─── Warmup XML ──────────────────────────────────────────────────────────────
async function fetchWarmupUrls(baseUrl) {
  const candidates = [
    baseUrl + '/cache-warmup.xml',
  ];

  for (const url of candidates) {
    try {
      log.info('Проверяю cache warmup XML: ' + url);
      const res = await fetch(url, { accept: 'application/xml,text/xml,*/*' });
      log.debug('Cache warmup XML статус: ' + res.status + ', content-type: ' + res.headers['content-type']);

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
        log.info('Cache warmup XML index: ' + smaps.length + ' дочерних карт');
        for (const sm of smaps) {
          const smUrl = sm.loc && sm.loc[0];
          if (!smUrl) continue;
          try {
            log.debug('Загружаю дочерний cache warmup XML: ' + smUrl);
            const r2 = await fetch(smUrl, { accept: 'application/xml,*/*' });
            const p2 = await parseStringPromise(r2.body, { explicitArray: true });
            for (const u of (p2.urlset && p2.urlset.url || [])) {
              if (u.loc && u.loc[0]) urls.add(u.loc[0]);
            }
          } catch (e) { log.debug('Дочерний cache warmup XML ERR: ' + e.message); }
        }
      }

      for (const u of (parsed.urlset && parsed.urlset.url || [])) {
        if (u.loc && u.loc[0]) urls.add(u.loc[0]);
      }

      if (urls.size > 0) {
        log.success('Cache warmup XML: найдено ' + urls.size + ' URL');
        return [...urls];
      }
      log.warn('Cache warmup XML пустой: ' + url);
    } catch (e) {
      log.debug('Cache warmup XML ERR: ' + url + ' — ' + e.message);
    }
  }

  log.warn('Cache warmup XML не найден, стартуем с главной страницы');
  return [baseUrl];
}

// ─── Очередь страниц из cache-warmup.xml ────────────────────────────────────
async function warmPages(startUrls) {
  const urls = [...new Set(startUrls)].slice(0, CONFIG.maxPages);
  log.info('\n--- Страниц в очереди из cache-warmup.xml: ' + urls.length + ' ---');
  await runQueue(urls, CONFIG.concurrentPages, warmPage);
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
  log.info('Макс. страниц из XML: ' + CONFIG.maxPages + '\n');

  try {
    await ensureNeonDatabaseAwake();

    const base    = new URL(CONFIG.baseUrl);
    const allUrls = await fetchWarmupUrls(CONFIG.baseUrl);
    const filtered = allUrls.filter(u => {
      try { return new URL(u).hostname === base.hostname && isHtmlPage(u); } catch { return false; }
    });
    await warmPages(filtered.length ? filtered : [CONFIG.baseUrl]);
  } catch (e) {
    log.error('Критическая ошибка: ' + e.message);
  } finally {
    await closeBrowser();
    printReport();
  }
})();
