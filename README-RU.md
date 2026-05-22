# 🔥 CDN Cache Warmer

Инструмент для прогрева CDN кеша. Берёт страницы из `cache-warmup.xml` и принудительно загружает все ассеты:
**JS-скрипты, CSS, изображения (включая lazy-load), шрифты, preload-ресурсы**.

---
## Быстрый старт

```bash
npm install
SITE_URL=https://example.com npm start
```

---

## Переменные окружения

| Переменная          | По умолчанию          | Описание                                         |
|---------------------|-----------------------|--------------------------------------------------|
| `SITE_URL`          | `https://example.com` | Целевой сайт                                     |
| `CONCURRENT_PAGES`  | `3`                   | Сколько страниц прогревать параллельно           |
| `CONCURRENT_ASSETS` | `8`                   | Сколько ассетов загружать параллельно            |
| `MAX_PAGES`         | `200`                 | Максимум страниц для обработки                  |
| `DELAY_PAGES`       | `500`                 | Пауза между страницами (мс)                     |
| `DELAY_ASSETS`      | `50`                  | Пауза между ассетами (мс)                       |
| `REQUEST_TIMEOUT`   | `15000`               | Таймаут HTTP-запроса (мс)                        |
| `WARM_MOBILE_HTML`  | `true`                | Дополнительно парсить страницы как мобильный браузер |
| `BROWSER_WARM`      | `true`                | Открывать страницы в браузере, скроллить и прогревать lazy-load изображения |
| `BROWSER_SCROLL_STEP` | `700`               | Размер шага прокрутки страницы в браузере (px)  |
| `BROWSER_SCROLL_DELAY` | `300`              | Пауза после каждого шага прокрутки (мс)         |
| `BROWSER_MAX_SCROLLS` | `80`                | Максимальное количество шагов прокрутки          |
| `VERBOSE`           | `false`               | Подробный лог каждого ассета                    |

---

## Режимы запуска

```bash
# Стандартный прогрев
SITE_URL=https://my-site.com npm start

# Большой список URL из cache-warmup.xml (до 500 страниц)
SITE_URL=https://my-site.com npm run warm:large

# Быстрый (максимальная параллельность)
SITE_URL=https://my-site.com npm run warm:fast

# С подробным логом
SITE_URL=https://my-site.com npm run warm:verbose
```

---

## Docker

```bash
# Сборка
docker build -t cdn-warmer .

# Запуск
docker run --rm \
  -e SITE_URL=https://your-site.com \
  -e CONCURRENT_PAGES=5 \
  cdn-warmer
```

---

## Автозапуск по расписанию (cron)

```cron
# Прогрев кеша каждые 6 часов
0 */6 * * * cd /opt/cdn-warmer && SITE_URL=https://your-site.com node warmer.js >> /var/log/cdn-warmer.log 2>&1
```

---

## Что именно прогревается

| Тип ресурса         | Как находится                                        |
|---------------------|------------------------------------------------------|
| HTML-страницы       | `cache-warmup.xml`                                   |
| JavaScript          | `<script src>`, динамические чанки в HTML            |
| CSS                 | `<link rel=stylesheet>`                              |
| Изображения (eager) | `<img src>`, `srcset`                                |
| Изображения (lazy)  | `data-src`, `data-lazy`, `data-original`             |
| CSS-фоны            | `url()` в инлайн-стилях и в `<style>`               |
| Шрифты              | `url()` в загруженных CSS-файлах (woff/woff2/ttf)   |
| Preload-ресурсы     | `<link rel=preload>`                                 |

---

## Логика работы

```
1. Получить URL из cache-warmup.xml (или стартовать с главной)
2. Для каждой страницы:
   a. GET страницы → статус 2xx
   b. Парсинг HTML → список ассетов
   c. Параллельная загрузка всех ассетов
   d. Для каждого CSS → извлечение и загрузка шрифтов
3. Открытие страницы в браузере → прокрутка → прогрев lazy-load изображений
4. Итоговый отчёт
```
