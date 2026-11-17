# Made by Switchboard (template: Laravel). Edit freely — Switchboard never overwrites it.
# 1) Front-end assets (Vite), when the app has a package.json
FROM node:24-alpine AS assets
WORKDIR /app
COPY . .
RUN if [ -f package.json ]; then \
      if [ -f package-lock.json ]; then npm ci; else npm install; fi && npm run build --if-present; \
    fi; mkdir -p public/build

# 2) PHP 8.4 + nginx (serversideup/php: production-ready Laravel image, listens on 8080)
FROM serversideup/php:8.4-fpm-nginx
ENV PHP_OPCACHE_ENABLE=1
COPY --chown=www-data:www-data . /var/www/html
COPY --chown=www-data:www-data --from=assets /app/public/build /var/www/html/public/build
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress
