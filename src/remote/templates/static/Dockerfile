# Made by Switchboard (template: static site / Vue SPA). Edit freely — Switchboard never overwrites it.
# With a package.json: "npm run build" and serve the build folder (BUILD_DIR, default dist).
# Without: the files are served as they are.
FROM node:24-alpine AS build
ARG BUILD_DIR=dist
WORKDIR /app
COPY . .
RUN mkdir -p /out && if [ -f package.json ]; then \
      (if [ -f package-lock.json ]; then npm ci; else npm install; fi) && npm run build && cp -r "$BUILD_DIR"/. /out/; \
    else cp -r . /out/ && rm -rf /out/.switchboard /out/compose.switchboard.yml; fi

FROM nginx:1.27-alpine
COPY --from=build /out /usr/share/nginx/html
# Single-page apps: unknown paths load index.html (client-side routing).
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
