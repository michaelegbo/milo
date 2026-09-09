# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS build
WORKDIR /app
ENV NODE_LLAMA_CPP_SKIP_DOWNLOAD=true ONNXRUNTIME_NODE_INSTALL_CUDA=skip
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --include=optional --no-audit --no-fund
COPY . .
ARG MILO_BUILD_REVISION=unknown
ENV VITE_MILO_DEVICE_ONLY=1 VITE_AUDIO_MODEL_BASE=/models/
RUN node scripts/prepare-browser-assets.mjs \
    && npm run build \
    && node -e "require('fs').writeFileSync('dist/release.json', JSON.stringify({revision:process.argv[1],processing:'device-default',replyProviders:['device','personal-chatgpt']}))" "$MILO_BUILD_REVISION"

# Production contains only static files. No Node or server inference engine.
FROM nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
ARG MILO_BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="Milo" \
      org.opencontainers.image.source="https://github.com/michaelegbo/milo" \
      org.opencontainers.image.revision="${MILO_BUILD_REVISION}" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY LICENSE /usr/share/nginx/html/LICENSE
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
