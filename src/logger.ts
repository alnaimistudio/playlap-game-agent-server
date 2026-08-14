/**
 * Structured JSON logs with secret redaction. Per-job logs are appended as
 * NDJSON under DATA_DIR/jobs/{jobId}/logs.ndjson (see jobs.ts wiring).
 */
import fs from "node:fs";
import path from "node:path";

const SECRET_ENV_KEYS = [
  "PLAYLAP_AGENT_API_KEY",
  "MODEL_API_KEY",
] as const;

function secretValues(): string[] {
  return SECRET_ENV_KEYS.map((k) => process.env[k]?.trim() ?? "").filter((v) => v.length >= 6);
}

export function redact(text: string): string {
  let out = text;
  for (const v of secretValues()) out = out.split(v).join("[REDACTED]");
  out = out.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]");
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  jobId?: string;
  [key: string]: unknown;
}

type Sink = (entry: LogEntry) => void;
const sinks = new Map<string, Sink>();

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...JSON.parse(redact(JSON.stringify(fields))),
  };
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
  const jobId = typeof entry.jobId === "string" ? entry.jobId : undefined;
  if (jobId) sinks.get(jobId)?.(entry);
}

export function attachJobLogFile(jobId: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "logs.ndjson");
  sinks.set(jobId, (entry) => {
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    } catch {
      /* logging must never crash a job */
    }
  });
}

export function detachJobLogFile(jobId: string): void {
  sinks.delete(jobId);
}
