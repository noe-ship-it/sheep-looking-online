FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
EXPOSE 3000
USER node
HEALTHCHECK CMD wget -qO- http://localhost:${PORT:-3000}/healthz || exit 1
CMD ["node", "server/index.js"]
