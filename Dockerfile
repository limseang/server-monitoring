# Switchboard — server failover / Cloudflare DNS switch / DB sync dashboard
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

RUN apk add --no-cache tini su-exec tzdata

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: ssh2 only uses install scripts for optional native speed-ups; pure JS works fine.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
