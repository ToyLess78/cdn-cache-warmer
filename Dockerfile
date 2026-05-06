FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY warmer.js .

# По умолчанию — переменные среды
ENV SITE_URL=https://example.com
ENV CONCURRENT_PAGES=3
ENV CONCURRENT_ASSETS=8
ENV CRAWL_DEPTH=2
ENV MAX_PAGES=200
ENV DELAY_PAGES=500
ENV DELAY_ASSETS=50
ENV VERBOSE=false

CMD ["node", "warmer.js"]
