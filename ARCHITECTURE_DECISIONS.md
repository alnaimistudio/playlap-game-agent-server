# Architecture Decisions — Play Lap Game Agent Server

Standalone autonomous game-development server. Nothing here touches Play Lap
production or its existing game-generation code.

## 1. Model runtime: llama.cpp `llama-server` (not vLLM, not Ollama)

**Decision:** run Qwen3-Coder-30B-A3B-Instruct as a GGUF quant (Q4_K_M,
~18GB) under llama.cpp's `llama-server`, exposed as a local OpenAI-compatible
endpoint on `127.0.0.1:8080`.

**Why:**
- **24GB VRAM fit.** Qwen3-Coder-30B is a MoE model (30B total / ~3.3B active).
  Q4_K_M GGUF (~18.6GB) fits an RTX 4090 with full GPU offload plus a 32k
  context; vLLM needs AWQ/GPTQ weights plus generous KV-cache headroom and is
  much tighter on a single 24GB card.
- **Tool calling.** llama.cpp's `--jinja` flag applies Qwen's native chat
  template, including its tool-call format, and exposes standard
  `tools`/`tool_calls` on `/v1/chat/completions` — exactly what the agent
  loop consumes.
- **Ollama** is a wrapper around llama.cpp; it adds a model-management layer
  we don't need inside a single-purpose image and historically lags on
  tool-calling/template fixes for new models.
- **Swap-ability preserved:** the server only ever talks to a
  `ModelProvider`; `local` is literally the `openai-compatible` provider
  pointed at localhost. Replacing Qwen with anything else is a URL + model
  name change (env vars), no code change.

**License check:** llama.cpp — MIT. Qwen3-Coder — Apache-2.0 (weights usable
commercially). CUDA base image — NVIDIA EULA (standard for GPU containers).

## 2. Agent framework: purpose-built loop (not OpenHands)

**Decision:** implement a small, purpose-built agent loop
(Plan → Code → Build → Run → See → Play → Fix → Retest → Quality Gate) rather
than embedding OpenHands.

**Why:**
- OpenHands (MIT — license itself is fine) is a general software-engineering
  agent: it expects its own Docker-in-Docker sandbox runtime, an event-stream
  architecture, and a far larger dependency surface. Running it *inside* an
  already-containerized GPU pod adds a privileged-Docker requirement RunPod
  templates don't guarantee, and would fight our single-image goal.
- Our domain is narrow and repeatable: one workspace layout, two engines,
  one QA harness. A ~500-line loop with explicit tools (write/read/edit/
  search/run/install/done) is auditable, deterministic to test (mock
  provider), and doesn't take a 30B model off-guard with complex prompting.
- The tool-calling contract is standard OpenAI `tools`, so a future swap to a
  stronger model or even a hosted agent API requires no rework.

## 3. game-creator (playableintelligence) — ideas only, no dependency

**Decision:** borrow the *workflow ideas* (plan doc → build → browser QA →
visual review → repair loop → quality gate; 2D + 3D tracks) without importing
the project as a dependency.

**Why:** it is coupled to its own deployment platform, and vendoring it would
drag in dependencies we'd have to license-audit transitively. Everything we
need from it is process, which is reimplemented here natively. No AGPL code
is imported (see LICENSE_NOTES.md — notably we avoid AGPL-licensed audio
tooling entirely by generating art/sound procedurally in the games).

## 4. Game engines: Phaser (2D) + Babylon.js (3D), vendored offline

**Decision:** ship `phaser` (MIT) and `babylonjs` (Apache-2.0) inside the
image; every workspace gets a local `vendor/` copy. Generated games never load
from CDNs.

**Why:** deterministic builds and playtests with zero network dependency in
the QA loop; matches Play Lap's existing Babylon usage; both licenses are
permissive so generated games impose nothing on Play Lap.

Engines are configurable per-dimension today (`2d`→phaser, `3d`→babylon) and
the workspace records its engine in `package.json`, so adding Three.js or
another engine later is additive.

## 5. Build pipeline: static assembly + syntax gate (no bundler in v1)

**Decision:** generated games are static sites (index.html + src/ + vendor/);
"build" = `node --check` every JS file + assemble `build/`. No Vite/bundler
step in v1 (vite stays in the package allowlist for later).

**Why:** removes npm-install network flakiness and multi-minute installs from
every job on a GPU billed by the minute; a static game is also exactly what
Play Lap's WebView needs. The quality gate replaces "the bundler compiled" as
the health signal with something stronger: the game actually ran in Chromium
without errors and responded to input.

## 6. Isolation model (in-process confinement, container as outer wall)

- Each job is confined to `/workspaces/{jobId}` — all agent tools resolve
  paths through a traversal-safe resolver that also blocks `.env*` and `.git`.
- Commands run with no shell, an allowlist (`node`, `ls`, `cat`), 30s
  timeouts, capped output, and `HOME` pointed inside the workspace.
- Package installs come from an allowlist and are vendored locally (no
  network).
- Playtests run in headless Chromium against a loopback static server that
  only serves the job's `build/` directory.
- Secrets: the API key never reaches workspaces; logs pass through a redactor.
- The Docker container itself is the outer wall (no Docker socket mounted,
  non-privileged). Full per-job kernel sandboxing (gVisor/firecracker) is
  intentionally out of scope for a single-tenant tool server.

## 7. Queue & persistence

Single-process FIFO queue, `MAX_CONCURRENT_JOBS=1` by default (one heavy job
per GPU); extra requests are queued, never failed (until `MAX_QUEUE_LENGTH`).
Job state is persisted as JSON per job under `/data`, so restarts keep
history (in-flight jobs are marked failed on boot). No external
Redis/Postgres — one fewer moving part on a disposable GPU pod.

## 8. Future /v1/games/{id}/edit

Workspaces are git repositories with checkpoints at every phase; the job
store keeps workspace paths and results. An edit endpoint later only needs
to: reopen the workspace (or unzip the stored artifact into a new one),
checkpoint, run the same repair-style loop with the edit prompt, and re-run
QA — no architectural change required.

## 9. Auto-shutdown

RunPod has no in-container "stop myself" API that is safe to rely on across
template types, so the server exposes `GET /v1/system/activity`
(busy/idleSeconds/metrics) as the idle signal for an external watcher or a
future RunPod serverless wrapper.
