FROM alpine:latest AS builder
RUN apk add --no-cache zip
WORKDIR /app
COPY extension extension
RUN zip -r wallgarden.zip extension

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY extension /usr/share/nginx/html/extension
COPY --from=builder /app/wallgarden.zip /usr/share/nginx/html/wallgarden.zip
COPY app/ /usr/share/nginx/html/
EXPOSE 8007
