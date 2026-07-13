FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "run", "production"]
