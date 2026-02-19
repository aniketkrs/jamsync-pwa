FROM node:20-slim

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --production

COPY server/ ./server/
COPY public/ ./public/

EXPOSE 8080

CMD ["node", "server/index.js"]
