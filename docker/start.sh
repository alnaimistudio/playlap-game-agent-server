#!/bin/bash
# ============================================================================
# Play Lap Game Agent Server — container startup
# 1. Detect GPU / VRAM / CUDA
# 2. Auto-download the Qwen GGUF model to the persistent /models volume
# 3. Start llama.cpp server (local OpenAI-compatible endpoint)
# 4. Start the Node agent server (health at /health)
# No SSH or manual setup needed after deployment.
# ============================================================================
set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/models}"
CACHE_DIR="${CACHE_DIR:-/cache}"
MODEL_GGUF_URL="${MODEL_GGUF_URL:-https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf}"
MODEL_FILE="${MODELS_DIR}/$(basename "${MODEL_GGUF_URL%%\?*}")"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-32768}"
LLAMA_GPU_LAYERS="${LLAMA_GPU_LAYERS:-999}"
MODEL_PROVIDER="${MODEL_PROVIDER:-local}"

mkdir -p "$MODELS_DIR" "$CACHE_DIR" /workspaces /data

echo "[start] Play Lap Game Agent Server booting…"

# ---- 1. GPU detection ----
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  echo "[start] GPU detected: ${GPU_NAME} (${VRAM_MB} MiB VRAM)"
  if [ "${VRAM_MB}" -lt 20000 ]; then
    echo "[start] WARNING: less than 20GB VRAM — Qwen3-Coder 30B Q4_K_M may not fit. Consider a smaller quant via MODEL_GGUF_URL."
  fi
else
  echo "[start] WARNING: no GPU detected."
  if [ "$MODEL_PROVIDER" = "local" ]; then
    echo "[start] MODEL_PROVIDER=local requires a GPU. Falling back is NOT automatic — set MODEL_PROVIDER=openai-compatible or mock to run without one."
  fi
fi

# ---- 2 & 3. model download + llama.cpp (local provider only) ----
if [ "$MODEL_PROVIDER" = "local" ]; then
  if [ ! -s "$MODEL_FILE" ]; then
    echo "[start] Model not found in volume — downloading (one-time, ~18GB)…"
    curl -fL --retry 5 --retry-delay 10 -C - -o "${MODEL_FILE}.part" "$MODEL_GGUF_URL"
    mv "${MODEL_FILE}.part" "$MODEL_FILE"
    echo "[start] Model downloaded to ${MODEL_FILE}"
  else
    echo "[start] Model already present: ${MODEL_FILE}"
  fi

  LLAMA_BIN=$(command -v llama-server || echo /opt/llama/build/bin/llama-server)
  echo "[start] Starting llama.cpp server…"
  "$LLAMA_BIN" \
    --model "$MODEL_FILE" \
    --ctx-size "$LLAMA_CTX_SIZE" \
    --n-gpu-layers "$LLAMA_GPU_LAYERS" \
    --host 127.0.0.1 --port 8080 \
    --jinja --flash-attn \
    >/data/llama-server.log 2>&1 &
  LLAMA_PID=$!

  echo "[start] Waiting for the model to load (this can take a few minutes on first boot)…"
  MODEL_READY=0
  for i in $(seq 1 120); do
    if curl -fsS http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
      echo "[start] Model runtime is ready."
      MODEL_READY=1
      break
    fi
    if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
      echo "[start] ERROR: llama-server exited. Last log lines:"
      tail -20 /data/llama-server.log || true
      exit 1
    fi
    sleep 5
  done
  if [ "$MODEL_READY" -ne 1 ]; then
    echo "[start] ERROR: model did not become ready within the timeout. Failing startup."
    kill "$LLAMA_PID" 2>/dev/null || true
    exit 1
  fi
fi

# ---- 4. Chromium sandbox probe ----
# Chromium's user-namespace sandbox needs the container runtime to permit
# unprivileged user namespaces (Docker default seccomp blocks clone(CLONE_NEWUSER)).
# Probe it; if it cannot start, fail loudly unless the operator explicitly
# accepts the fallback with ALLOW_NO_SANDBOX=1 (games still run as non-root
# `agent` with browser-level egress blocking, but without the ns sandbox).
if [ "${CHROMIUM_NO_SANDBOX:-0}" != "1" ]; then
  echo "[start] Probing Chromium sandbox support…"
  if node /app/dist/sandbox-probe.js >/dev/null 2>&1; then
    echo "[start] Chromium sandbox OK."
  elif [ "${ALLOW_NO_SANDBOX:-0}" = "1" ]; then
    echo "[start] WARNING: Chromium sandbox unavailable; continuing with --no-sandbox because ALLOW_NO_SANDBOX=1 (explicitly accepted)."
    export CHROMIUM_NO_SANDBOX=1
  else
    echo "[start] ERROR: Chromium sandbox cannot start on this runtime."
    echo "[start] Either run the container with a seccomp profile that allows unprivileged user namespaces"
    echo "[start] (see docker/CHROMIUM_SANDBOX.md in the repo for guidance), or set ALLOW_NO_SANDBOX=1"
    echo "[start] to explicitly accept running Chromium without its namespace sandbox."
    exit 1
  fi
fi

# ---- 5. agent server ----
echo "[start] Starting agent server on port ${PORT:-8700}…"
cd /app
exec node dist/index.js
