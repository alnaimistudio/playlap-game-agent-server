# ============================================================================
# Play Lap Game Agent Server — single image for RunPod (RTX 4090 / 24GB VRAM)
# Runs: llama.cpp server (Qwen3-Coder 30B GGUF) + Node agent server + Chromium
# The model is NOT baked into the image — it is auto-downloaded on first boot
# to the persistent /models volume by docker/start.sh.
# ============================================================================
# --- Stage 1: build llama.cpp (llama-server) with CUDA from source ---------
# llama.cpp no longer publishes Linux CUDA prebuilt binaries, so we compile a
# pinned tag ourselves. CMAKE_CUDA_ARCHITECTURES=89 = Ada (RTX 4090).
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS llama-build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential curl ca-certificates libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*
ARG LLAMA_CPP_TAG=b6148
RUN git clone --depth 1 --branch ${LLAMA_CPP_TAG} https://github.com/ggml-org/llama.cpp /opt/llama-src \
    && cmake -S /opt/llama-src -B /opt/llama-src/build \
         -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 \
         -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
         -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /opt/llama-src/build --target llama-server -j"$(nproc)" \
    && mkdir -p /opt/llama/bin \
    && cp /opt/llama-src/build/bin/llama-server /opt/llama/bin/ \
    && cp /opt/llama-src/build/bin/*.so* /opt/llama/bin/ 2>/dev/null || true

# --- Stage 1b: empty llama placeholder (LOCAL_WINDOWS mode) -----------------
# When the model runs OUTSIDE the container (e.g. Ollama on the Windows host),
# there is no need to compile llama.cpp. docker-compose.yml selects this stage
# via the LLAMA_FROM build arg to skip the long CUDA build entirely.
FROM ubuntu:22.04 AS llama-empty
RUN mkdir -p /opt/llama/bin

# --- Stage 1c: selectable llama source (default: real build) ----------------
ARG LLAMA_FROM=llama-build
FROM ${LLAMA_FROM} AS llama-src

# --- Stage 2: runtime image -------------------------------------------------
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    MODELS_DIR=/models \
    CACHE_DIR=/cache \
    WORKSPACES_DIR=/workspaces \
    DATA_DIR=/data \
    MODEL_PROVIDER=local \
    PORT=8700

# --- system deps + Node 20 ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git zip unzip xz-utils gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- llama.cpp server (compiled in stage 1) ---
COPY --from=llama-src /opt/llama/bin /opt/llama/bin
ENV PATH="/opt/llama/bin:${PATH}" \
    LD_LIBRARY_PATH="/opt/llama/bin:${LD_LIBRARY_PATH}"

WORKDIR /app

# --- server deps (includes Playwright chromium download) ---
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm install --no-save typescript@5.9 @types/node @types/express tsx
# Playwright browser + system libs for headless Chromium QA
# Installed to a fixed path so the non-root user (below) can use them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.55.0 install --with-deps chromium \
    && npm cache clean --force

# --- app source ---
COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY docker ./docker
RUN npx tsc -p tsconfig.json && cp -r src/public dist/public

# --- run as a dedicated non-root user; keep Chromium's sandbox intact ---
RUN useradd -m -u 10001 -s /usr/sbin/nologin agent \
    && mkdir -p /models /cache /workspaces /data \
    && chown -R agent:agent /app /models /cache /workspaces /data /ms-playwright
USER agent

# Persistent volumes (mount these on RunPod)
VOLUME ["/models", "/cache", "/workspaces", "/data"]

EXPOSE 8700
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8700/health || exit 1

ENTRYPOINT ["/bin/bash", "/app/docker/start.sh"]
