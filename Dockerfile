FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY tools/excel_pdf/requirements.txt /tmp/excel-pdf-requirements.txt
RUN python3 -m venv /opt/excel-pdf \
    && /opt/excel-pdf/bin/pip install --no-cache-dir -r /tmp/excel-pdf-requirements.txt
ENV EXCEL_PDF_PYTHON=/opt/excel-pdf/bin/python

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .
RUN /opt/excel-pdf/bin/python tools/excel_pdf/check_install.py
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "run", "production"]
