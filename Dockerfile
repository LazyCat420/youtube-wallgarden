# ── Build stage: zip the extension for the download link ──
FROM alpine:latest AS builder
RUN apk add --no-cache zip
WORKDIR /app
COPY extension extension
RUN zip -r wallgarden.zip extension

# ── Build stage: minify app.js / app.css ──
FROM node:20-alpine AS minifier
WORKDIR /build
COPY app/ app/
RUN npx --yes terser@5.27.0 app/app.js -o app/app.min.js --compress --mangle \
    && npx --yes clean-css-cli@5.6.3 app/app.css -o app/app.min.css

# ── Final image: nginx (static + proxies) AND the Python sync API, together,
#    run side-by-side by supervisord. One container, one port (8007). ──
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Sync API (self-contained: stores data in SQLite on the /data volume)
WORKDIR /app/sync
COPY sync-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY sync-service/main.py .
RUN mkdir -p /data

# nginx site config (its /sync/ location proxies to 127.0.0.1:8017)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static dashboard + extension + zip
COPY extension /usr/share/nginx/html/extension
COPY --from=builder /app/wallgarden.zip /usr/share/nginx/html/wallgarden.zip
COPY app/ /usr/share/nginx/html/
COPY --from=minifier /build/app/app.min.js /usr/share/nginx/html/app.min.js
COPY --from=minifier /build/app/app.min.css /usr/share/nginx/html/app.min.css

# Run both processes
COPY supervisord.conf /etc/supervisor/conf.d/wallgarden.conf

EXPOSE 8007
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]
