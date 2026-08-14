/**
 * In-process FIFO job queue. One heavy generation job at a time by default
 * (MAX_CONCURRENT_JOBS). A second request is queued — never failed — unless
 * the queue itself is full (MAX_QUEUE_LENGTH).
 */
import { config } from "./config.js";
import { log } from "./logger.js";
import { Job, getJob, updateJob } from "./jobs.js";

export interface QueueStats {
  queued: number;
  running: number;
  maxConcurrent: number;
  totalStarted: number;
  totalCompleted: number;
  totalFailed: number;
  totalCancelled: number;
  lastActivityAt: string; // for idle-based auto-shutdown decisions (external)
  durationsMs: number[];
}

const pending: string[] = [];
const runningIds = new Set<string>();
const cancelRequested = new Set<string>();
export const stats: QueueStats = {
  queued: 0,
  running: 0,
  maxConcurrent: config.maxConcurrentJobs,
  totalStarted: 0,
  totalCompleted: 0,
  totalFailed: 0,
  totalCancelled: 0,
  lastActivityAt: new Date().toISOString(),
  durationsMs: [],
};

let runner: ((job: Job, isCancelled: () => boolean) => Promise<void>) | null = null;

export function setRunner(fn: (job: Job, isCancelled: () => boolean) => Promise<void>): void {
  runner = fn;
}

export function enqueue(job: Job): { position: number } {
  if (pending.length >= config.maxQueueLength) {
    throw Object.assign(new Error("Queue is full, try again later."), { statusCode: 429 });
  }
  pending.push(job.jobId);
  stats.lastActivityAt = new Date().toISOString();
  touchStats();
  log("info", "job queued", { jobId: job.jobId, position: pending.length });
  setImmediate(pump);
  return { position: pending.length };
}

export function requestCancel(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job) return false;
  if (job.status === "queued") {
    const i = pending.indexOf(jobId);
    if (i >= 0) pending.splice(i, 1);
    updateJob(job, { status: "cancelled", stage: "failed", finishedAt: new Date().toISOString(), error: "Cancelled while queued." });
    stats.totalCancelled += 1;
    touchStats();
    return true;
  }
  if (job.status === "running") {
    cancelRequested.add(jobId);
    return true;
  }
  return false;
}

function touchStats(): void {
  stats.queued = pending.length;
  stats.running = runningIds.size;
  stats.lastActivityAt = new Date().toISOString();
}

async function pump(): Promise<void> {
  if (!runner) return;
  while (runningIds.size < config.maxConcurrentJobs && pending.length > 0) {
    const jobId = pending.shift()!;
    const job = getJob(jobId);
    if (!job || job.status !== "queued") continue;
    runningIds.add(jobId);
    stats.totalStarted += 1;
    touchStats();
    const startedAt = Date.now();
    updateJob(job, { status: "running", startedAt: new Date().toISOString() });
    runner(job, () => cancelRequested.has(jobId))
      .then(() => {
        if (job.status === "completed") stats.totalCompleted += 1;
        else if (job.status === "cancelled") stats.totalCancelled += 1;
        else stats.totalFailed += 1;
      })
      .catch((err) => {
        stats.totalFailed += 1;
        updateJob(job, {
          status: "failed",
          stage: "failed",
          finishedAt: new Date().toISOString(),
          error: String(err?.message ?? err),
        });
        log("error", "job crashed", { jobId, error: String(err?.stack ?? err) });
      })
      .finally(() => {
        stats.durationsMs.push(Date.now() - startedAt);
        if (stats.durationsMs.length > 100) stats.durationsMs.shift();
        runningIds.delete(jobId);
        cancelRequested.delete(jobId);
        touchStats();
        setImmediate(pump);
      });
  }
}
