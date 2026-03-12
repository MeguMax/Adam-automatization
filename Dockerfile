FROM mcr.microsoft.com/playwright:v1.58.2

ENV PLAYWRIGHT_CHROMIUM_USE_HEADLESS_NEW=false

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

CMD ["node", "dist/index.js"]
