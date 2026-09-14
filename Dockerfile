# Multi-stage build — works on Linux servers and Windows (Docker Desktop)
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY tools/license-gen/package.json ./tools/license-gen/
RUN npm install
COPY . .
RUN npm run build -w web && npm run build -w server

FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    VIXEL_HOST=0.0.0.0 \
    VIXEL_PORT=8080 \
    VIXEL_DATA_DIR=/data \
    VIXEL_RECORDINGS_DIR=/recordings \
    VIXEL_FFMPEG_PATH=ffmpeg \
    VIXEL_FFPROBE_PATH=ffprobe
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY tools/license-gen/package.json ./tools/license-gen/
RUN npm install --omit=dev -w server \
  && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data /recordings
VOLUME ["/data", "/recordings"]
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "dist/index.js"]
