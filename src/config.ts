import path from "node:path";
import fs from "node:fs";

function num(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function str(name: string, def = ""): string {
  return process.env[name]?.trim() || def;
}

const rootDir = process.cwd();

export const config = {
  port: num("PORT", 8700),
  apiKey: str("PLAYLAP_AGENT_API_KEY"),
  workspacesDir: path.resolve(rootDir, str("WORKSPACES_DIR", "./workspaces")),
  dataDir: path.resolve(rootDir, str("DATA_DIR", "./data")),

  modelProvider: str("MODEL_PROVIDER", "mock") as "mock" | "openai-compatible" | "local",
  modelName: str("MODEL_NAME", "qwen3-coder-30b-a3b-instruct"),
  modelBaseUrl: str("MODEL_BASE_URL"),
  modelApiKey: str("MODEL_API_KEY"),
  modelMaxTokens: num("MODEL_MAX_TOKENS", 8192),
  // Provider/protocol retries (malformed tool-call XML, 5xx, timeouts) —
  // separate from QA repair and syntax budgets.
  modelProtocolRetries: Math.max(0, num("MODEL_PROTOCOL_RETRIES", 3)),

  maxConcurrentJobs: Math.max(1, num("MAX_CONCURRENT_JOBS", 1)),
  maxBuildIterations: Math.max(1, num("MAX_BUILD_ITERATIONS", 3)),
  maxRepairIterations: num("MAX_REPAIR_ITERATIONS", 3),
  jobTimeoutMs: Math.max(1, num("JOB_TIMEOUT_MINUTES", 25)) * 60_000,
  maxWorkspaceMb: Math.max(10, num("MAX_WORKSPACE_MB", 200)),
  maxQueueLength: Math.max(1, num("MAX_QUEUE_LENGTH", 20)),

  rateLimitWindowMs: Math.max(1, num("RATE_LIMIT_WINDOW_SECONDS", 60)) * 1000,
  rateLimitMax: Math.max(1, num("RATE_LIMIT_MAX_REQUESTS", 120)),

  chromiumPath:
    str("PLAYWRIGHT_CHROMIUM_PATH") ||
    str("REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE") ||
    "", // empty → playwright-core default resolution (Docker image installs browsers)

  serverRoot: rootDir,
};

export function assertConfig(): void {
  if (!config.apiKey || config.apiKey.length < 8) {
    throw new Error(
      "PLAYLAP_AGENT_API_KEY is required (min 8 chars). Set it in the environment — never bake it into the image.",
    );
  }
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
}
