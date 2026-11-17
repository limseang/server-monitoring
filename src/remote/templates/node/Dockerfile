# Made by Switchboard (template: Node.js / Nuxt). Edit freely — Switchboard never overwrites it.
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build --if-present
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NITRO_PORT=3000
EXPOSE 3000
# Nuxt 3/4 builds to .output/server/index.mjs; anything else uses "npm start".
CMD ["sh", "-c", "if [ -f .output/server/index.mjs ]; then exec node .output/server/index.mjs; else exec npm start; fi"]
