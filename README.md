# 🔥 CDN Cache Warmer

A CDN cache warming tool. It reads pages from `cache-warmup.xml` and force-loads all assets:
**JavaScript files, CSS, images (including lazy-loaded images), fonts, and preload resources**.

---

## Quick Start

```bash
npm install
SITE_URL=https://example.com npm start
```

---

## Environment Variables

| Variable            | Default               | Description                                      |
|---------------------|-----------------------|--------------------------------------------------|
| `SITE_URL`          | `https://example.com` | Target website                                   |
| `CONCURRENT_PAGES`  | `3`                   | Number of pages to warm in parallel              |
| `CONCURRENT_ASSETS` | `8`                   | Number of assets to load in parallel             |
| `MAX_PAGES`         | `200`                 | Maximum number of pages to process               |
| `DELAY_PAGES`       | `500`                 | Delay between pages (ms)                         |
| `DELAY_ASSETS`      | `50`                  | Delay between assets (ms)                        |
| `REQUEST_TIMEOUT`   | `15000`               | HTTP request timeout (ms)                        |
| `WARM_MOBILE_HTML`  | `true`                | Also parse pages as a mobile browser             |
| `BROWSER_WARM`      | `true`                | Open pages in a browser, scroll, and warm lazy-loaded images |
| `BROWSER_SCROLL_STEP` | `700`               | Browser scroll step size (px)                    |
| `BROWSER_SCROLL_DELAY` | `300`              | Delay after each browser scroll step (ms)        |
| `BROWSER_MAX_SCROLLS` | `80`                | Maximum number of browser scroll steps           |
| `VERBOSE`           | `false`               | Detailed log output for every asset              |

---

## Run Modes

```bash
# Standard cache warmup
SITE_URL=https://my-site.com npm start

# Large URL list from cache-warmup.xml (up to 500 pages)
SITE_URL=https://my-site.com npm run warm:large

# Fast warmup (maximum parallelism)
SITE_URL=https://my-site.com npm run warm:fast

# With detailed logging
SITE_URL=https://my-site.com npm run warm:verbose
```

---

## Docker

```bash
# Build
docker build -t cdn-warmer .

# Run
docker run --rm \
  -e SITE_URL=https://your-site.com \
  -e CONCURRENT_PAGES=5 \
  cdn-warmer
```

---

## Scheduled Run (cron)

```cron
# Warm the cache every 6 hours
0 */6 * * * cd /opt/cdn-warmer && SITE_URL=https://your-site.com node warmer.js >> /var/log/cdn-warmer.log 2>&1
```

---

## What Gets Warmed

| Resource type       | How it is discovered                                 |
|---------------------|------------------------------------------------------|
| HTML pages          | `cache-warmup.xml`                                   |
| JavaScript          | `<script src>`, dynamic chunks in HTML               |
| CSS                 | `<link rel=stylesheet>`                              |
| Images (eager)      | `<img src>`, `srcset`                                |
| Images (lazy)       | `data-src`, `data-lazy`, `data-original`             |
| CSS backgrounds     | `url()` in inline styles and `<style>` blocks        |
| Fonts               | `url()` in loaded CSS files (woff/woff2/ttf)         |
| Preload resources   | `<link rel=preload>`                                 |

---

## How It Works

```
1. Get URLs from cache-warmup.xml (or start from the homepage)
2. For each page:
   a. GET the page → expect a 2xx status
   b. Parse HTML → collect assets
   c. Load all assets in parallel
   d. For each CSS file → extract and load fonts
3. Open the page in a browser → scroll → warm lazy-loaded images
4. Print the final report
```
