FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY warmer.js .

# По умолчанию — переменные среды
ENV SITE_URL=https://example.com
ENV CONCURRENT_PAGES=3
ENV CONCURRENT_ASSETS=8
ENV MAX_PAGES=200
ENV DELAY_PAGES=500
ENV DELAY_ASSETS=50
ENV BROWSER_WARM=true
ENV BROWSER_SCROLL_STEP=700
ENV BROWSER_SCROLL_DELAY=300
ENV BROWSER_MAX_SCROLLS=80
ENV VERBOSE=false

CMD ["node", "warmer.js"]
