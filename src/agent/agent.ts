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
import { classifyModelError } from "../model/retry.js";
import {
  Workspace,
  createWorkspace,
  checkpoint,
  enforceSizeLimit,
  currentCommit,
  rollbackTo,
  rollbackToLastCheckpoint,
  diffSince,
} from "./workspace.js";
import { TOOL_DEFS, executeTool } from "./tools.js";
import { PERSONA, planningPrompt, codingPrompt, repairPrompt, syntaxFixPrompt, RepairContext } from "./skills.js";
import { playtest, PlaytestReport } from "./playtest.js";
import { evaluateQuality } from "./quality.js";
import { restoreInfrastructure, checkInfrastructure, staticEngineChecks } from "./staticChecks.js";
import { QAIssue, fatalCount, issueSignature, formatIssues, analyzeRepairScope } from "./qaTypes.js";

const MAX_AGENT_TURNS = 60;
/**
 * Syntax repairs have their OWN small budget, separate from the runtime/QA
 * repair budget: a typo introduced while fixing runtime behavior must not
 * consume a full QA cycle (requirement: separate BUILD/SYNTAX from RUNTIME
 * repair attempts).
 */
const MAX_SYNTAX_FIXES_PER_REPAIR = 2;

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
    const planRes = await chatWithProtocolRetry(
      provider,
      ws,
      "planning",
      [
        { role: "system", content: `${PERSONA}\n${planningPrompt(job.dimension, job.prompt, job.language)}` },
        { role: "user", content: job.prompt },
      ],
      [],
      guard,
    );
    const plan = planRes.content.trim() || `# Game Design\n${job.prompt}`;
    fs.writeFileSync(path.join(ws.root, "game-design.md"), plan);
    checkpoint(ws, "plan: game-design.md");
    setStage("planning", 12, "Design document written");

    // ---- coding ----
    guard();
    setStage("coding", 15, "Agent is implementing the game");
    // Malformed coding output is never checkpointed: if the syntax gate
    // cannot restore valid JS, revert to the clean scaffold and retry the
    // whole coding phase once before giving up.
    for (let codingAttempt = 1; ; codingAttempt++) {
      await toolLoop(provider, ws, job, `${PERSONA}\n${codingPrompt(job.dimension, job.prompt, plan)}`, guard, `coding-${codingAttempt}`);
      if (await syntaxGate(provider, ws, job, guard, setStage)) break;
      if (codingAttempt >= 2) {
        throw new Error("Coding phase produced invalid JavaScript that could not be repaired.");
      }
      pushEvent(job, "coding", "coding output had unfixable syntax errors — reverting to scaffold and re-implementing");
      rollbackToLastCheckpoint(ws);
    }
    checkpoint(ws, "coding complete");

    // ---- build / static-check / run / playtest / repair loop ----
    // Observe → diagnose → edit → syntax check → build → playtest → compare.
    // Regressions are auto-reverted to the last known-good checkpoint, and
    // repeated failure signatures force the model to re-diagnose.
    let report: PlaytestReport | null = null;
    let buildError: string | null = null;
    let lastGoodReport: PlaytestReport | null = null;
    let lastGoodCommit: string | null = null;
    const attemptedSignatures: string[] = [];
    const attemptHistory: string[] = [];
    // Diff of what the previous repair changed, snapshotted BEFORE any
    // rollback (after a revert, recomputing the diff would yield nothing).
    let lastRepairDiff: string | null = null;
    // Deterministic scope complaint about the PREVIOUS repair (oversized rewrite).
    let lastScopeWarning: string | null = null;
    let rolledBack = false;
    // Hard cap on total loop passes so separated budgets can never spin forever.
    const maxLoopPasses = config.maxBuildIterations + config.maxRepairIterations + 4;
    while (true) {
      guard();
      buildIterations += 1;
      if (buildIterations > maxLoopPasses) {
        throw new Error(`Exceeded ${maxLoopPasses} build/QA loop passes without converging.`);
      }
      setStage("building", 40, `Build iteration ${buildIterations}`);
      // Protect required bootstrap infrastructure deterministically — never
      // burn a model repair on a deleted vendor file or missing hook helper.
      for (const n of restoreInfrastructure(ws)) pushEvent(job, "building", `infrastructure: ${n}`);
      buildError = buildGame(ws);
      if (buildError) {
        // Should be rare — the syntax gate runs after every model edit phase.
        // Safety net: micro syntax-fix loop (own budget), then rollback to
        // last-known-good instead of failing the whole job.
        setStage("repairing", 45, `Build failed: ${buildError.slice(0, 120)}`);
        const fixed = await syntaxGate(provider, ws, job, guard, setStage);
        if (fixed) {
          checkpoint(ws, `syntax fixed at build iteration ${buildIterations}`);
          continue;
        }
        if (lastGoodCommit) {
          pushEvent(job, "repairing", "unfixable build failure — reverting to last good checkpoint");
          rollbackTo(ws, lastGoodCommit);
          rolledBack = true;
          attemptHistory.push("a repair introduced unfixable syntax errors and was reverted");
          continue;
        }
        throw new Error(`Build failed and could not be repaired: ${buildError}`);
      }
      checkpoint(ws, `build ok #${buildIterations}`);

      // Deterministic static checks (infrastructure + engine-specific smells)
      // run before spending a browser session; their findings are appended to
      // the QA evidence, never a replacement for runtime QA.
      const staticIssues: QAIssue[] = [...checkInfrastructure(ws), ...staticEngineChecks(ws)];

      guard();
      setStage("running", 55, "Starting the game in a sandboxed local server");
      setStage("playtesting", 65, "Playing the game in headless Chromium");
      report = await playtest(ws, path.join(ws.root, "build"), job.jobId, buildIterations);
      report.issues.push(...staticIssues);
      // Static/infrastructure findings are part of the verdict, not advisory.
      if (staticIssues.some((i) => i.severity !== "warning")) report.ok = false;
      pushEvent(
        job,
        "playtesting",
        `QA: engine=${report.engineLoaded} canvas=${report.canvasPresent} paint=${report.canvasPaintedRatio.toFixed(2)} hook=${report.hookContractOk ? "ok" : report.testHook ? "incomplete" : "missing"} fatal=${fatalCount(report.issues)} errors=${report.consoleErrors.length + report.pageErrors.length}`,
      );

      // Regression protection: if this iteration lost the engine/canvas/hook
      // or added fatal errors vs the last good state, revert and retry
      // differently instead of keeping the damage.
      rolledBack = false;
      if (lastGoodReport && lastGoodCommit && isRegression(lastGoodReport, report)) {
        pushEvent(job, "repairing", `regression detected — reverting to last good checkpoint`);
        rollbackTo(ws, lastGoodCommit);
        rolledBack = true;
        report = lastGoodReport;
      } else if (!lastGoodReport || !isWorse(lastGoodReport, report)) {
        lastGoodReport = report;
        lastGoodCommit = currentCommit(ws);
      }

      if (report.ok) break;
      if (repairIterations >= config.maxRepairIterations) {
        // keep the evidence and let the quality gate decide below
        break;
      }
      repairIterations += 1;
      const sig = issueSignature(report.issues);
      const repeatedFailure = attemptedSignatures.includes(sig);
      attemptedSignatures.push(sig);
      // If the same failure survived the previous repair, show the model
      // exactly what that repair changed so it stops iterating on a dead end.
      const ctx: RepairContext = {
        repeatedFailure,
        rolledBack,
        previousAttempts: attemptHistory,
        previousDiff: repeatedFailure && lastRepairDiff ? lastRepairDiff : undefined,
        scopeWarning: lastScopeWarning ?? undefined,
      };
      lastScopeWarning = null;
      setStage("repairing", 70, `Repair iteration ${repairIterations}: ${report.notes.join("; ").slice(0, 140) || "QA issues"}`);
      const evidence = formatIssues(report.issues);
      const preRepairCommit = currentCommit(ws);
      const fullRepairPrompt = `${PERSONA}\n${repairPrompt(evidence || "Unknown QA failure", ctx)}`;
      // Forensics: persist the EXACT model input for this repair. artifacts/
      // is git-ignored, so no later rollback can erase it.
      persistQaArtifact(ws, `repair-input-iteration-${repairIterations}.txt`, fullRepairPrompt);
      const summary = await toolLoop(provider, ws, job, fullRepairPrompt, guard, `repair-${repairIterations}`);
      // A repair is NEVER accepted until every JS file parses. The syntax
      // micro-loop has its own budget; if the model can't restore valid
      // syntax, the whole repair is reverted (valid code must never be
      // replaced by invalid code).
      const syntaxOk = await syntaxGate(provider, ws, job, guard, setStage);
      // Snapshot the COMPLETE repair diff (primary repair + any syntax-fix
      // edits) NOW — after all edits, before any rollback/checkpoint can
      // erase it — so a repeated failure can show the model the failed diff
      // and the persisted evidence matches what actually happened.
      if (preRepairCommit) {
        const d = diffSince(ws, preRepairCommit, 30_000);
        lastRepairDiff = (d ? d.slice(0, 3000) : "") || lastRepairDiff;
        persistQaArtifact(
          ws,
          `repair-diff-iteration-${repairIterations}.patch`,
          (d || "(repair produced no changes)") + (syntaxOk ? "" : "\n\n# NOTE: this repair left unfixable syntax errors and was reverted."),
        );
        // Deterministic scope check: a pinpointed failure (file:line) answered
        // by a huge multi-system rewrite is prime regression material. Never a
        // rejection by itself — the next repair prompt demands a localized fix
        // and the diff itself becomes evidence.
        if (d) {
          const scope = analyzeRepairScope(d, report.issues);
          persistQaArtifact(ws, `repair-scope-iteration-${repairIterations}.json`, JSON.stringify(scope, null, 2));
          if (scope.oversized) {
            lastScopeWarning =
              `your previous repair changed ${scope.totalChangedLines} lines across ${scope.changedFiles.map((f) => f.file).join(", ")} ` +
              `while the evidence pointed only at ${scope.evidenceFiles.join(", ") || "specific lines"}` +
              (scope.unrelatedFiles.length ? ` (files changed WITHOUT any evidence: ${scope.unrelatedFiles.join(", ")})` : "") +
              ` — large unrelated rewrites are how regressions happen.`;
            pushEvent(job, "repairing", `repair #${repairIterations} was much larger than the evidence justified (${scope.totalChangedLines} changed lines)`);
          }
        }
      }
      if (!syntaxOk) {
        if (preRepairCommit) {
          pushEvent(job, "repairing", "repair introduced unfixable syntax errors — reverting the repair");
          rollbackTo(ws, preRepairCommit);
          rolledBack = true;
        }
        attemptHistory.push(`repair ${repairIterations} introduced syntax errors and was reverted — that approach is broken`);
        if (attemptHistory.length > 6) attemptHistory.shift();
        continue;
      }
      attemptHistory.push(summary || report.notes[0]?.slice(0, 120) || `attempt ${repairIterations}`);
      if (attemptHistory.length > 6) attemptHistory.shift();
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

/**
 * Verify every JS file in src/ parses. Returns a rich, model-friendly error
 * (file, line, nearby source, Node's message) or null when clean.
 * Exported for tests.
 */
/**
 * Provider call with a SEPARATE model/protocol retry budget. A malformed
 * tool-call response (e.g. Ollama HTTP 500 "XML syntax error"), a provider
 * 5xx, or a transport timeout is not a generated-game failure: it is
 * retried here without consuming QA repair or syntax budgets. Safe by
 * construction: provider.chat() throws BEFORE any tool executes, so a
 * failed attempt cannot modify or checkpoint the workspace — tools of a
 * turn only run after its response parsed successfully.
 * Every failed attempt is persisted as artifacts/qa/model-error-<tag>-attempt-N.json.
 */
export async function chatWithProtocolRetry(
  provider: ModelProvider,
  ws: Workspace,
  tag: string,
  messages: ChatMessage[],
  tools = TOOL_DEFS,
  guard: () => void = () => undefined,
): Promise<Awaited<ReturnType<ModelProvider["chat"]>>> {
  const maxRetries = config.modelProtocolRetries;
  for (let attempt = 1; ; attempt++) {
    try {
      guard(); // job deadline/cancellation applies to every retry attempt too
      return await provider.chat(messages, tools);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      const classification = classifyModelError(message);
      persistQaArtifact(
        ws,
        `model-error-${tag}-attempt-${attempt}.json`,
        JSON.stringify(
          {
            phase: tag,
            attempt,
            maxRetries,
            provider: provider.name,
            model: (provider as { modelName?: string }).modelName ?? null,
            httpStatus: Number(message.match(/HTTP (\d{3})/)?.[1]) || null,
            classification,
            error: message.slice(0, 2000),
            workspaceRolledBack: false,
            note: "provider.chat() failed before any tool of this turn executed — workspace unchanged, nothing checkpointed",
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      log("warn", "model protocol failure", { jobId: ws.jobId, tag, attempt, classification, error: message.slice(0, 200) });
      if (classification === "fatal" || attempt > maxRetries) {
        throw new Error(
          `Model provider failed (${classification}${classification === "retryable" ? `, ${attempt} attempts` : ""}): ${message.slice(0, 300)} — evidence in artifacts/qa/model-error-${tag}-attempt-*.json`,
        );
      }
      guard(); // never sleep past a cancelled/expired job
      await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 8000)));
    }
  }
}

/**
 * Append-only forensic evidence under artifacts/qa/. The directory is
 * git-ignored, so no checkpoint/rollback can ever delete or rewrite it —
 * what the repair model saw is exactly what remains after the job ends.
 */
function persistQaArtifact(ws: Workspace, name: string, content: string): void {
  try {
    const dir = path.join(ws.root, "artifacts", "qa");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  } catch (err) {
    log("warn", "failed to persist QA artifact", { jobId: ws.jobId, name, error: String(err) });
  }
}

export function checkJsSyntax(ws: Workspace): string | null {
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
      const raw = String((err as any).stderr ?? err);
      const rel = path.relative(ws.root, f);
      const lineMatch = raw.match(/:(\d+)\n/);
      const line = lineMatch ? Number(lineMatch[1]) : undefined;
      let context = "";
      if (line) {
        const source = fs.readFileSync(f, "utf8").split("\n");
        const from = Math.max(0, line - 4);
        const to = Math.min(source.length, line + 3);
        context = source
          .slice(from, to)
          .map((l, i) => `${from + i + 1 === line ? ">>" : "  "} ${from + i + 1}| ${l}`)
          .join("\n");
      }
      return `Syntax error in ${rel}${line ? ` at line ${line}` : ""}:\n${raw.slice(0, 400)}\n${context ? `Nearby source:\n${context}` : ""}`;
    }
  }
  return null;
}

/**
 * Syntax micro-loop: after ANY model edit phase, re-check all JS files and —
 * if broken — give the model focused fix rounds with exact file/line/nearby
 * source evidence. Separate small budget; never consumes runtime/QA repairs.
 * Returns true when all files parse.
 */
async function syntaxGate(
  provider: ModelProvider,
  ws: Workspace,
  job: Job,
  guard: () => void,
  setStage: (stage: Stage, progress: number, note: string) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_SYNTAX_FIXES_PER_REPAIR; attempt++) {
    const err = checkJsSyntax(ws);
    if (!err) return true;
    if (attempt === MAX_SYNTAX_FIXES_PER_REPAIR) {
      pushEvent(job, "repairing", `syntax still broken after ${attempt} fix rounds: ${err.slice(0, 120)}`);
      return false;
    }
    setStage("repairing", 68, `Syntax fix round ${attempt + 1}: ${err.split("\n")[0].slice(0, 120)}`);
    await toolLoop(provider, ws, job, `${PERSONA}\n${syntaxFixPrompt(err)}`, guard, `syntaxfix-${attempt + 1}`);
  }
  return false;
}

/** Regression: the new iteration lost working infrastructure or added fatal failures. */
function isRegression(prev: PlaytestReport, next: PlaytestReport): boolean {
  if (prev.ok && !next.ok) return true;
  if (prev.engineLoaded && !next.engineLoaded) return true;
  if (prev.canvasPresent && !next.canvasPresent) return true;
  if (prev.testHook !== null && next.testHook === null) return true;
  return fatalCount(next.issues) > fatalCount(prev.issues);
}

/** Strictly worse (used to decide whether to advance the known-good checkpoint). */
function isWorse(prev: PlaytestReport, next: PlaytestReport): boolean {
  return isRegression(prev, next);
}

/**
 * Generic model tool-calling loop for a phase. Returns the model's `done`
 * summary (root-cause description during repair) or an empty string.
 */
async function toolLoop(
  provider: ModelProvider,
  ws: Workspace,
  job: Job,
  systemPrompt: string,
  guard: () => void,
  tag = "phase",
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${systemPrompt}\ndimension: ${job.dimension}` },
    { role: "user", content: job.prompt },
  ];
  let edits = 0;
  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    guard();
    const res = await chatWithProtocolRetry(provider, ws, `${tag}-turn-${turn + 1}`, messages, TOOL_DEFS, guard);
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return res.content.slice(0, 200); // model finished with a plain message
    for (const call of res.toolCalls) {
      if (call.name === "done") {
        // A repair phase must not "finish" without touching anything.
        if (/PHASE: repairing/.test(systemPrompt) && edits === 0 && turn < MAX_AGENT_TURNS - 1) {
          messages.push({
            role: "tool",
            content: "REJECTED: you called done without editing any file. Read the evidence, inspect the offending files, and make a fix first.",
            toolCallId: call.id,
          });
          continue;
        }
        return String(call.arguments.summary ?? "").slice(0, 200);
      }
      if (call.name === "write_file" || call.name === "edit_file") edits += 1;
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
  const syntaxError = checkJsSyntax(ws);
  if (syntaxError) return syntaxError;
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
