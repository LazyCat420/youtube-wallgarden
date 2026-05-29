FROM alpine:latest AS builder
RUN apk add --no-cache zip
WORKDIR /app
COPY extension extension
RUN zip -r wallgarden.zip extension

# Minification stage — produces app.min.js and app.min.css
FROM node:20-alpine AS minifier
WORKDIR /build
COPY app/ app/
RUN npx --yes terser@5.27.0 app/app.js -o app/app.min.js --compress --mangle \
    && npx --yes clean-css-cli@5.6.3 app/app.css -o app/app.min.css

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY extension /usr/share/nginx/html/extension
COPY --from=builder /app/wallgarden.zip /usr/share/nginx/html/wallgarden.zip
COPY app/ /usr/share/nginx/html/
# Overlay minified files on top of originals
COPY --from=minifier /build/app/app.min.js /usr/share/nginx/html/app.min.js
COPY --from=minifier /build/app/app.min.css /usr/share/nginx/html/app.min.css
EXPOSE 8007
