/**
 * Job model + on-disk persistence (survives restarts). One JSON file per job
 * under DATA_DIR/jobs/{jobId}/job.json, plus logs.ndjson next to it.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { attachJobLogFile } from "./logger.js";

export type Dimension = "2d" | "3d";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Stage =
  | "queued"
  | "planning"
  | "coding"
  | "building"
  | "running"
  | "playtesting"
  | "repairing"
  | "polishing"
  | "completed"
  | "failed";

export interface JobResult {
  jobId: string;
  dimension: Dimension;
  engine: string;
  buildStatus: "ok" | "failed";
  qualityScore: number; // 0..100
  qualityChecks: Record<string, { pass: boolean; note?: string }>;
  durationMs: number;
  model: string;
  provider: string;
  iterations: { build: number; repair: number };
  artifact: { file: string; bytes: number; sha256: string } | null;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  stage: Stage;
  progress: number; // 0..100
  dimension: Dimension;
  prompt: string;
  language: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  lastError?: string;
  result?: JobResult;
  /** short human-readable stage notes for the /test page */
  events: { ts: string; stage: Stage; note: string }[];
}

const jobs = new Map<string, Job>();

export function jobDir(jobId: string): string {
  return path.join(config.dataDir, "jobs", jobId);
}

export function workspaceDir(jobId: string): string {
  return path.join(config.workspacesDir, jobId);
}

function persist(job: Job): void {
  const dir = jobDir(job.jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
}

export function createJob(dimension: Dimension, prompt: string, language: string): Job {
  const jobId = crypto.randomUUID();
  const job: Job = {
    jobId,
    status: "queued",
    stage: "queued",
    progress: 0,
    dimension,
    prompt,
    language,
    createdAt: new Date().toISOString(),
    events: [],
  };
  jobs.set(jobId, job);
  attachJobLogFile(jobId, jobDir(jobId));
  persist(job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function allJobs(): Job[] {
  return [...jobs.values()];
}

export function updateJob(job: Job, patch: Partial<Job>): Job {
  Object.assign(job, patch);
  persist(job);
  return job;
}

export function pushEvent(job: Job, stage: Stage, note: string): void {
  job.events.push({ ts: new Date().toISOString(), stage, note });
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
  persist(job);
}

/** Reload persisted jobs on boot; anything that was mid-flight becomes failed. */
export function loadPersistedJobs(): void {
  const root = path.join(config.dataDir, "jobs");
  if (!fs.existsSync(root)) return;
  for (const id of fs.readdirSync(root)) {
    const file = path.join(root, id, "job.json");
    try {
      const job = JSON.parse(fs.readFileSync(file, "utf8")) as Job;
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.stage = "failed";
        job.error = "Server restarted while the job was in flight.";
        fs.writeFileSync(file, JSON.stringify(job, null, 2));
      }
      jobs.set(job.jobId, job);
    } catch {
      /* ignore corrupt job dirs */
    }
  }
}
