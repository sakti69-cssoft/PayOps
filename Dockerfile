FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /app/.runtime /app/node_modules/.vite-temp /app/node_modules/.vite && chown -R node:node /app/.runtime /app/node_modules/.vite-temp /app/node_modules/.vite
USER node
CMD ["npm","run","api"]
