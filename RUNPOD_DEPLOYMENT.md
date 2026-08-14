# RunPod Deployment Guide (non-technical, step by step)

You do NOT need SSH or any manual setup inside the server. After deployment
everything installs itself, including the AI model.

## What you need before starting

1. A RunPod account (runpod.io) with some credit.
2. The Docker image name. After you push this project to GitHub, GitHub
   Actions builds it automatically and publishes:
   `ghcr.io/<your-github-username>/playlap-game-agent-server:latest`
   (Make the package public in GitHub → your profile → Packages, or add
   registry credentials in RunPod if you keep it private.)
3. An API key you invent yourself — any long random text (40+ characters).
   This is the password Play Lap will use to talk to the server.

## Step 1 — Create a Network Volume (keeps the model between restarts)

1. RunPod → **Storage** → **New Network Volume**.
2. Name: `playlap-models`. Size: **50 GB**. Pick a region that has RTX 4090s.
3. Create it.

## Step 2 — Create the Pod

1. RunPod → **Pods** → **Deploy**.
2. GPU: **RTX 4090 (24 GB)**. Same region as the volume.
3. **Container image:** `ghcr.io/<your-github-username>/playlap-game-agent-server:latest`
4. **Volume:** attach `playlap-models`, mount path: `/models`
5. **Container disk:** 30 GB or more.
6. **Expose HTTP port:** `8700`
7. **Environment variables** (Pod → Environment Variables):
   | Name | Value |
   |---|---|
   | `PLAYLAP_AGENT_API_KEY` | your long random key from above |
   | `MODEL_PROVIDER` | `local` |
   | `ALLOW_NO_SANDBOX` | `1` (see note below) |
8. Deploy.

> **About `ALLOW_NO_SANDBOX`:** the test browser normally runs with Chromium's
> extra security sandbox. RunPod templates don't let you change the Docker
> security settings that sandbox needs, so the server refuses to start unless
> you explicitly accept running without it by setting `ALLOW_NO_SANDBOX=1`.
> Other protections stay on (non-root user, game network access fully blocked
> except its own test page, isolated per-game folders). If you self-host with
> plain Docker instead, leave this unset — see `docker/CHROMIUM_SANDBOX.md`.

## Step 3 — First boot (be patient once)

On the very first start the server downloads the AI model (~18 GB) into the
volume. This takes 10–30 minutes depending on region. Later restarts skip it.

Watch progress: Pod → **Logs**. You'll see lines like
`[start] Model not found in volume — downloading…` and finally
`Play Lap Game Agent Server listening`.

## Step 4 — Check it works

1. Find your pod's URL: Pod → **Connect** → HTTP port 8700. It looks like
   `https://xxxxx-8700.proxy.runpod.net`.
2. Open `https://…/health` in a browser. You should see
   `"status":"ok"` with `model`, `browser` and `queue` all ok.
3. Open `https://…/test`, paste your API key, keep the fishing prompt and
   press **Create Game**. Watch the stages run; when finished press
   **Play the game** and **Download game-build.zip**.

## Step 5 — Give the URL + key to Play Lap (later phase)

When we wire Play Lap to this server (a separate task), the only two values
needed are the pod URL and your `PLAYLAP_AGENT_API_KEY`.

## Costs & idling

The pod bills while it runs. The server exposes
`GET /v1/system/activity` (with your API key) that reports
`busy` / `idleSeconds` — you can check it before stopping the pod, or use it
later for automated stop rules. Stopping the pod is safe: the model stays on
the volume, jobs history stays on `/data` only if you also mount a volume
there (optional).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` shows model not ok | First boot still loading — wait, check Logs. |
| `unauthorized` | The `Authorization: Bearer` key doesn't match `PLAYLAP_AGENT_API_KEY`. |
| Pod restarts repeatedly | Check GPU has 24 GB; smaller GPUs need a smaller `MODEL_GGUF_URL` quant. |
| Want a different model | Change `MODEL_GGUF_URL` (any GGUF) + `MODEL_NAME`, restart pod. |
