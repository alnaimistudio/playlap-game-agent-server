/**
 * Autonomous agent core: Plan → Code → Build → Run → See → Play → Fix →
 * Retest → Quality Gate. Real stages, bounded by MAX_BUILD_ITERATIONS,
 * MAX_REPAIR_ITERATIONS and JOB_TIMEOUT.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { config } from "../config.js";
import { log, detachJobLogFile } from "../logger.js";
import { Job, JobResult, Stage, pushEvent, updateJob } from "../jobs.js";
import { ModelProvider, ChatMessage } from "../model/provider.js";
import { Workspace, createWorkspace, checkpoint, enforceSizeLimit } from "./workspace.js";
import { TOOL_DEFS, executeTool } from "./tools.js";
import { PERSONA, planningPrompt, codingPrompt, repairPrompt } from "./skills.js";
import { playtest, PlaytestReport } from "./playtest.js";
import { evaluateQuality } from "./quality.js";

const MAX_AGENT_TURNS = 60;

class JobCancelled extends Error {
  constructor() {
    super("Job cancelled by request.");
  }
}
class JobTimeout extends Error {
  constructor() {
    super(`Job exceeded timeout of ${config.jobTimeoutMs / 60000} minutes.`);
  }
}

export async function runJob(provider: ModelProvider, job: Job, isCancelled: () => boolean): Promise<void> {
  const t0 = Date.now();
  const deadline = t0 + config.jobTimeoutMs;
  const engine = job.dimension === "3d" ? "babylon" : "phaser";
  const guard = (): void => {
    if (isCancelled()) throw new JobCancelled();
    if (Date.now() > deadline) throw new JobTimeout();
  };
  const setStage = (stage: Stage, progress: number, note: string): void => {
    updateJob(job, { stage, progress });
    pushEvent(job, stage, note);
    log("info", `stage: ${stage}`, { jobId: job.jobId, progress, note });
  };

  let ws: Workspace | null = null;
  let buildIterations = 0;
  let repairIterations = 0;
  try {
    // ---- planning ----
    guard();
    setStage("planning", 5, "Creating workspace and game design document");
    ws = createWorkspace(job.jobId, engine);
    const planRes = await provider.chat(
      [
        { role: "system", content: `${PERSONA}\n${planningPrompt(job.dimension, job.prompt, job.language)}` },
        { role: "user", content: job.prompt },
      ],
      [],
    );
    const plan = planRes.content.trim() || `# Game Design\n${job.prompt}`;
    fs.writeFileSync(path.join(ws.root, "game-design.md"), plan);
    checkpoint(ws, "plan: game-design.md");
    setStage("planning", 12, "Design document written");

    // ---- coding ----
    guard();
    setStage("coding", 15, "Agent is implementing the game");
    await toolLoop(provider, ws, job, `${PERSONA}\n${codingPrompt(job.dimension, job.prompt, plan)}`, guard);
    checkpoint(ws, "coding complete");

    // ---- build / run / playtest / repair loop ----
    let report: PlaytestReport | null = null;
    let buildError: string | null = null;
    while (true) {
      guard();
      buildIterations += 1;
      setStage("building", 40, `Build iteration ${buildIterations}`);
      buildError = buildGame(ws);
      if (buildError) {
        setStage("repairing", 45, `Build failed: ${buildError.slice(0, 120)}`);
        if (repairIterations >= config.maxRepairIterations || buildIterations >= config.maxBuildIterations) {
          throw new Error(`Build failed after ${buildIterations} iterations: ${buildError}`);
        }
        repairIterations += 1;
        await toolLoop(provider, ws, job, `${PERSONA}\n${repairPrompt(`Build error:\n${buildError}`)}`, guard);
        checkpoint(ws, `repair after build failure #${repairIterations}`);
        continue;
      }
      checkpoint(ws, `build ok #${buildIterations}`);

      guard();
      setStage("running", 55, "Starting the game in a sandboxed local server");
      setStage("playtesting", 65, "Playing the game in headless Chromium");
      report = await playtest(ws, path.join(ws.root, "build"), job.jobId);
      pushEvent(
        job,
        "playtesting",
        `QA: canvas=${report.canvasPresent} paint=${report.canvasPaintedRatio.toFixed(2)} hook=${report.testHook ? "yes" : "no"} errors=${report.consoleErrors.length + report.pageErrors.length}`,
      );
      if (report.ok) break;

      if (repairIterations >= config.maxRepairIterations) {
        // keep the evidence and let the quality gate decide below
        break;
      }
      repairIterations += 1;
      setStage("repairing", 70, `Repair iteration ${repairIterations}: ${report.notes.join("; ").slice(0, 140) || "console errors"}`);
      const qaText = [
        ...report.pageErrors.map((e) => `Page error: ${e}`),
        ...report.consoleErrors.map((e) => `Console error: ${e}`),
        ...report.notes,
      ].join("\n");
      await toolLoop(provider, ws, job, `${PERSONA}\n${repairPrompt(qaText || "Unknown QA failure")}`, guard);
      checkpoint(ws, `repair #${repairIterations}`);
    }

    // ---- polishing (mobile heuristics) ----
    guard();
    setStage("polishing", 85, "Mobile polish checks");
    const polishNotes = polishChecks(ws);
    for (const n of polishNotes) pushEvent(job, "polishing", n);

    // ---- quality gate ----
    guard();
    const quality = evaluateQuality(ws, report!, polishNotes);
    log("info", "quality gate", { jobId: job.jobId, score: quality.score, blockers: quality.blockers });
    if (quality.blockers.length > 0) {
      throw new Error(`Quality gate blocked: ${quality.blockers.join("; ")}`);
    }

    // ---- artifacts ----
    const artifact = packageArtifacts(ws, job, quality.score, quality.checks, Date.now() - t0, provider, {
      build: buildIterations,
      repair: repairIterations,
    });
    updateJob(job, {
      status: "completed",
      stage: "completed",
      progress: 100,
      finishedAt: new Date().toISOString(),
      result: artifact,
    });
    pushEvent(job, "completed", `Quality score ${quality.score}/100, artifact ${artifact.artifact?.file}`);
  } catch (err) {
    const cancelled = err instanceof JobCancelled;
    updateJob(job, {
      status: cancelled ? "cancelled" : "failed",
      stage: "failed",
      finishedAt: new Date().toISOString(),
      error: String((err as Error).message),
      lastError: String((err as Error).message),
    });
    pushEvent(job, "failed", String((err as Error).message).slice(0, 300));
    // Keep logs, workspace metadata, screenshots and last error for investigation.
    log(cancelled ? "info" : "error", "job ended without success", {
      jobId: job.jobId,
      cancelled,
      error: String((err as Error).message),
      buildIterations,
      repairIterations,
    });
  } finally {
    detachJobLogFile(job.jobId);
  }
}

/** Generic model tool-calling loop for a phase. */
async function toolLoop(
  provider: ModelProvider,
  ws: Workspace,
  job: Job,
  systemPrompt: string,
  guard: () => void,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${systemPrompt}\ndimension: ${job.dimension}` },
    { role: "user", content: job.prompt },
  ];
  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    guard();
    const res = await provider.chat(messages, TOOL_DEFS);
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return; // model finished with a plain message
    for (const call of res.toolCalls) {
      if (call.name === "done") return;
      let output: string;
      try {
        output = await executeTool(ws, call.name, call.arguments);
      } catch (err) {
        output = `ERROR: ${String((err as Error).message)}`;
      }
      log("debug", `tool ${call.name}`, { jobId: job.jobId, args: summarizeArgs(call.arguments), output: output.slice(0, 200) });
      messages.push({ role: "tool", content: output, toolCallId: call.id });
    }
    enforceSizeLimit(ws);
  }
  throw new Error("Agent exceeded max turns in a phase without calling done.");
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  }
  return out;
}

/**
 * Build = syntax-check every JS file, then assemble the static production
 * build (index.html + src + assets + vendor + public) into build/.
 * Returns an error string or null on success.
 */
function buildGame(ws: Workspace): string | null {
  const indexFile = path.join(ws.root, "index.html");
  if (!fs.existsSync(indexFile)) return "index.html is missing at the workspace root.";
  const jsFiles: string[] = [];
  const collect = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith(".js")) jsFiles.push(p);
    }
  };
  collect(path.join(ws.root, "src"));
  for (const f of jsFiles) {
    try {
      execFileSync("node", ["--check", f], { timeout: 15_000, encoding: "utf8" });
    } catch (err) {
      return `Syntax error in ${path.relative(ws.root, f)}: ${String((err as any).stderr ?? err).slice(0, 400)}`;
    }
  }
  const buildDir = path.join(ws.root, "build");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.copyFileSync(indexFile, path.join(buildDir, "index.html"));
  for (const d of ["src", "assets", "vendor", "public"]) {
    const from = path.join(ws.root, d);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(buildDir, d), { recursive: true });
  }
  return null;
}

/** Lightweight mobile-first heuristics logged as polish notes (non-blocking). */
function polishChecks(ws: Workspace): string[] {
  const notes: string[] = [];
  const html = fs.readFileSync(path.join(ws.root, "index.html"), "utf8");
  if (!/viewport/i.test(html)) notes.push("polish: index.html lacks a mobile viewport meta tag");
  const srcDir = path.join(ws.root, "src");
  let hasTouch = false;
  if (fs.existsSync(srcDir)) {
    for (const f of fs.readdirSync(srcDir)) {
      if (!f.endsWith(".js")) continue;
      const code = fs.readFileSync(path.join(srcDir, f), "utf8");
      if (/pointerdown|touchstart|onPointer|touchscreen|pointerup/i.test(code)) hasTouch = true;
    }
  }
  if (!hasTouch) notes.push("polish: no touch/pointer handlers detected in src/");
  if (notes.length === 0) notes.push("polish: mobile checks passed (viewport meta + touch handlers present)");
  return notes;
}

function packageArtifacts(
  ws: Workspace,
  job: Job,
  score: number,
  checks: JobResult["qualityChecks"],
  durationMs: number,
  provider: ModelProvider,
  iterations: { build: number; repair: number },
): JobResult {
  const artifactsDir = path.join(ws.root, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const zipPath = path.join(artifactsDir, "game-build.zip");
  fs.rmSync(zipPath, { force: true });
  execFileSync("zip", ["-rq", zipPath, "build", "game-design.md", "package.json"], {
    cwd: ws.root,
    timeout: 60_000,
  });
  const buf = fs.readFileSync(zipPath);
  const result: JobResult = {
    jobId: job.jobId,
    dimension: job.dimension,
    engine: ws.engine === "babylon" ? "babylonjs" : "phaser",
    buildStatus: "ok",
    qualityScore: score,
    qualityChecks: checks,
    durationMs,
    model: provider.modelName,
    provider: provider.name,
    iterations,
    artifact: { file: "artifacts/game-build.zip", bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") },
  };
  fs.writeFileSync(path.join(artifactsDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
