# 🔥 CDN Cache Warmer

A CDN cache warming tool. It crawls site pages and force-loads all assets:
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
| `CRAWL_DEPTH`       | `2`                   | Link crawling depth (0 = sitemap only)           |
| `MAX_PAGES`         | `200`                 | Maximum number of pages to process               |
| `DELAY_PAGES`       | `500`                 | Delay between pages (ms)                         |
| `DELAY_ASSETS`      | `50`                  | Delay between assets (ms)                        |
| `REQUEST_TIMEOUT`   | `15000`               | HTTP request timeout (ms)                        |
| `VERBOSE`           | `false`               | Detailed log output for every asset              |

---

## Run Modes

```bash
# Standard cache warmup
SITE_URL=https://my-site.com npm start

# Deep warmup (3 levels, up to 500 pages)
SITE_URL=https://my-site.com npm run warm:deep

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
  -e CRAWL_DEPTH=3 \
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
| HTML pages          | sitemap.xml → link crawling via `<a href>`           |
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
1. Get URLs from sitemap.xml (or start from the homepage)
2. For each page:
   a. GET the page → expect a 2xx status
   b. Parse HTML → collect assets + internal links
   c. Load all assets in parallel
   d. For each CSS file → extract and load fonts
3. Add discovered links to the queue (up to CRAWL_DEPTH)
4. Print the final report
```
