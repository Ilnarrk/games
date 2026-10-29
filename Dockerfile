FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=8080 DB_PATH=/app/data/game.sqlite
EXPOSE 8080
CMD ["node", "server/index.js"]
