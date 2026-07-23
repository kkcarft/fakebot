FROM node:22-bookworm-slim

WORKDIR /app

# 仅装生产依赖,大幅减小镜像
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY config.json ./config.json

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]