FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN mkdir -p /app/.runtime && chown node:node /app/.runtime
USER node
CMD ["npm","run","api"]
