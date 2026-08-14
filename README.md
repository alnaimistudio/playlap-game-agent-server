# Play Lap Game Agent Server

Standalone, self-hosted autonomous game development server. Receives a game
request over an authenticated REST API and an autonomous agent plans → codes
→ builds → runs → playtests in a real browser (Playwright/Chromium) → repairs
→ passes a quality gate → delivers a playable game build.

**Not connected to Play Lap production.** This folder is fully independent.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | API / model / agent / browser / queue status (no auth — used by healthchecks) |
| POST | `/v1/games` | `{ dimension: "2d"\|"3d", prompt, language? }` → `{ jobId, status: "queued" }` |
| GET | `/v1/jobs/{id}` | status, real stage (planning/coding/building/running/playtesting/repairing/polishing/completed/failed), progress, events |
| GET | `/v1/jobs/{id}/result` | final metadata (engine, quality score, duration, model, iterations, artifact hash) |
| GET | `/v1/jobs/{id}/artifact` | download `game-build.zip` |
| GET | `/v1/jobs/{id}/logs` | redacted structured log tail |
| POST | `/v1/jobs/{id}/cancel` | cancel queued/running job |
| GET | `/v1/system/activity` | busy/idle signal + job metrics (for auto-stop decisions) |
| GET | `/test` | small protected test console (create, watch stages, play, download) |

Auth: `Authorization: Bearer $PLAYLAP_AGENT_API_KEY` on everything except `/health`.

## Run locally (no GPU — mock provider)

```bash
cd game-agent-server
npm install
PLAYLAP_AGENT_API_KEY=dev-key-123456 MODEL_PROVIDER=mock npm run dev
# open http://localhost:8700/test
```

## Providers

`MODEL_PROVIDER=mock | openai-compatible | local` — see `.env.example`.
The agent only talks to the `ModelProvider` interface; swapping Qwen for any
OpenAI-compatible model is an env change.

## Deploy

- Docker image: see `Dockerfile` + `docker/start.sh` (GPU detect, auto model
  download to `/models`, llama.cpp + Qwen3-Coder 30B, healthcheck).
- CI: `.github/workflows/docker-build.yml` (GHCR; optional Docker Hub).
- RunPod, step by step: `RUNPOD_DEPLOYMENT.md`.

## Docs

- `ARCHITECTURE_DECISIONS.md` — runtime/agent-framework/licensing audit.
- `LICENSE_NOTES.md`, `THIRD_PARTY_LICENSES.md`.
