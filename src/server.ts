/**
 * REST API: Bearer-key auth, rate limiting, validation, security headers,
 * job endpoints, artifact download, idle/activity signal, and the protected
 * /test page.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { log } from "./logger.js";
import { createJob, getJob, allJobs, jobDir, workspaceDir } from "./jobs.js";
import { enqueue, requestCancel, stats } from "./queue.js";
import { ModelProvider } from "./model/provider.js";
import { probeBrowser, browserProbeResult } from "./agent/playtest.js";

const startedAt = Date.now();

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function extractKey(req: Request): string {
  const h = req.headers.authorization ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return ""; // never accept the API key via URL — URLs leak (logs, referrers, iframes)
}

// --- short-lived signed play tokens (so previews/downloads never carry the API key) ---
const tokenSecret = crypto.createHash("sha256").update(`playtoken:${config.apiKey}`).digest();
function signPlayToken(jobId: string, ttlMs = 10 * 60_000): { token: string; expiresAt: string } {
  const exp = Date.now() + ttlMs;
  const mac = crypto.createHmac("sha256", tokenSecret).update(`${jobId}.${exp}`).digest("base64url");
  return { token: `${exp}.${mac}`, expiresAt: new Date(exp).toISOString() };
}
function verifyPlayToken(jobId: string, token: string): boolean {
  const [expStr, mac] = String(token).split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false;
  const expect = crypto.createHmac("sha256", tokenSecret).update(`${jobId}.${exp}`).digest("base64url");
  return mac.length === expect.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}

function auth(req: Request, res: Response, next: NextFunction): void {
  if (timingSafeEq(extractKey(req), config.apiKey)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// --- naive fixed-window rate limiter (single-process server) ---
const rlBuckets = new Map<string, { count: number; windowStart: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const b = rlBuckets.get(ip);
  if (!b || now - b.windowStart > config.rateLimitWindowMs) {
    rlBuckets.set(ip, { count: 1, windowStart: now });
    return next();
  }
  b.count += 1;
  if (b.count > config.rateLimitMax) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  next();
}

const createGameSchema = z.object({
  dimension: z.enum(["2d", "3d"]),
  prompt: z.string().min(4).max(4000),
  language: z.string().min(2).max(10).optional().default("en"),
});

export function buildApp(provider: ModelProvider): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });
  app.use(rateLimit);

  // ---- health (unauthenticated by design: used by Docker/RunPod healthcheck) ----
  app.get("/health", async (_req, res) => {
    const model = await provider.status();
    // Real smoke probe (launch + page), cached; retried on demand if failing.
    let probe = browserProbeResult();
    if (!probe || !probe.ok) probe = await probeBrowser();
    const browserOk = probe.ok;
    const browserDetail = probe.detail;
    const ready = model.ok && browserOk;
    // Not ready → non-2xx so Docker/RunPod healthchecks fail until API,
    // model, agent and browser are ALL ready.
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "starting",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      api: { ok: true },
      model: { ok: model.ok, provider: provider.name, name: provider.modelName, detail: model.detail },
      agent: { ok: true, maxConcurrentJobs: config.maxConcurrentJobs },
      browser: { ok: browserOk, detail: browserDetail },
      queue: { queued: stats.queued, running: stats.running },
    });
  });

  const v1 = express.Router();

  // Artifact download: accepts either the Bearer API key or a short-lived
  // signed play token (never the API key in a URL). Declared before the
  // blanket auth middleware.
  v1.get("/jobs/:id/artifact", (req, res) => {
    const authed =
      timingSafeEq(extractKey(req), config.apiKey) ||
      (typeof req.query.token === "string" && verifyPlayToken(req.params.id, req.query.token));
    if (!authed) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const job = getJob(req.params.id);
    if (!job || job.status !== "completed" || !job.result?.artifact) {
      res.status(404).json({ error: "artifact_not_available" });
      return;
    }
    const file = path.join(workspaceDir(job.jobId), "artifacts", "game-build.zip");
    if (!fs.existsSync(file)) {
      res.status(410).json({ error: "artifact_gone" });
      return;
    }
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="game-${job.jobId}.zip"`);
    fs.createReadStream(file).pipe(res);
  });

  v1.use(auth);

  v1.post("/games", (req, res) => {
    const parsed = createGameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.issues.map((i) => i.message) });
      return;
    }
    try {
      const job = createJob(parsed.data.dimension, parsed.data.prompt, parsed.data.language);
      const { position } = enqueue(job);
      log("info", "game requested", { jobId: job.jobId, dimension: job.dimension, promptChars: job.prompt.length });
      res.status(202).json({ jobId: job.jobId, status: "queued", queuePosition: position });
    } catch (err: any) {
      res.status(err.statusCode ?? 500).json({ error: String(err.message) });
    }
  });

  v1.get("/jobs/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      events: job.events.slice(-30),
    });
  });

  v1.get("/jobs/:id/result", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (job.status !== "completed" || !job.result) {
      res.status(409).json({ error: "not_completed", status: job.status, stage: job.stage });
      return;
    }
    res.json(job.result);
  });

  // Issue a short-lived token for playing/downloading a finished game
  // without exposing the API key in any URL.
  v1.post("/jobs/:id/token", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ jobId: job.jobId, ...signPlayToken(job.jobId) });
  });

  v1.post("/jobs/:id/cancel", (req, res) => {
    const ok = requestCancel(req.params.id);
    if (!ok) {
      res.status(409).json({ error: "not_cancellable" });
      return;
    }
    res.json({ jobId: req.params.id, cancelRequested: true });
  });

  // Idle metric — external schedulers (RunPod auto-stop) can poll this.
  v1.get("/system/activity", (_req, res) => {
    const idleMs = stats.queued === 0 && stats.running === 0 ? Date.now() - Date.parse(stats.lastActivityAt) : 0;
    const d = stats.durationsMs;
    res.json({
      busy: stats.running > 0 || stats.queued > 0,
      idleSeconds: Math.round(idleMs / 1000),
      lastActivityAt: stats.lastActivityAt,
      queue: { queued: stats.queued, running: stats.running, maxConcurrent: stats.maxConcurrent },
      metrics: {
        totalStarted: stats.totalStarted,
        totalCompleted: stats.totalCompleted,
        totalFailed: stats.totalFailed,
        totalCancelled: stats.totalCancelled,
        avgDurationMs: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
      },
    });
  });

  // Short per-job log tail for the /test page (secrets already redacted at write time).
  v1.get("/jobs/:id/logs", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const file = path.join(jobDir(job.jobId), "logs.ndjson");
    if (!fs.existsSync(file)) {
      res.json({ lines: [] });
      return;
    }
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-80);
    res.json({ lines });
  });

  app.use("/v1", v1);

  // ---- protected /test page + built-game preview ----
  app.get("/test", (req, res) => {
    // The page itself asks for the key client-side; serving static HTML is safe.
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(fs.readFileSync(path.join(config.serverRoot, "src", "public", "test.html"), "utf8"));
  });

  // Serve a completed game's production build so /test can play it in a
  // SANDBOXED iframe. Authorized by a short-lived signed token embedded as a
  // path segment (so the game's relative asset requests inherit it) — the
  // API key never appears in URLs and the game runs in an opaque origin.
  app.get(/^\/play\/([0-9a-f-]{36})\/([A-Za-z0-9_.-]+)(\/.*)?$/, (req, res) => {
    const jobId = req.params[0];
    const token = req.params[1];
    if (!verifyPlayToken(jobId, token)) {
      res.status(401).send("unauthorized");
      return;
    }
    const rest = (req.params[2] ?? "/").replace(/^\/+/, "") || "index.html";
    const job = getJob(jobId);
    if (!job || !fs.existsSync(path.join(workspaceDir(jobId), "build"))) {
      res.status(404).send("not found");
      return;
    }
    const base = path.join(workspaceDir(jobId), "build");
    const file = path.resolve(base, rest);
    if (!file.startsWith(path.resolve(base) + path.sep) && file !== path.resolve(base, "index.html")) {
      res.status(403).send("forbidden");
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.status(404).send("not found");
      return;
    }
    res.sendFile(file);
  });

  app.get("/", (_req, res) => {
    res.json({ name: "Play Lap Game Agent Server", docs: "/test", health: "/health" });
  });

  // JSON 404 + error handler
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    log("error", "unhandled request error", { error: String(err?.message ?? err) });
    res.status(err?.statusCode ?? 500).json({ error: "internal_error" });
  });

  return app;
}

export function jobsSummary(): unknown {
  return allJobs().map((j) => ({ jobId: j.jobId, status: j.status, stage: j.stage }));
}
