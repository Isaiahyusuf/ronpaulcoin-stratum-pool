# Stratum pool service. Build context is the repository root.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY lib ./lib
COPY coins ./coins
COPY vendor ./vendor
ENV NODE_ENV=production
USER node
EXPOSE 3333
CMD ["node", "bin/pool.js"]
