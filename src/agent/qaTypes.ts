/**
 * Structured QA model — every problem found by static checks, the browser
 * playtest or the build system becomes a QAIssue with evidence (file, line,
 * stack, state) so the repair agent gets actionable diagnostics instead of
 * prose summaries.
 */

export type QAIssueType =
  | "infrastructure" // required bootstrap (vendor engine, script order, canvas)
  | "build"
  | "runtime" // uncaught page errors
  | "console" // console.error / relevant console.warn
  | "resource" // failed/blocked resource loads
  | "engine" // Phaser/Babylon failed to initialize
  | "testHook" // __PLAYLAP_TEST__ contract violations
  | "interaction" // input produced no meaningful state change
  | "visual" // blank canvas, no rendering
  | "static"; // deterministic engine-specific code smells

export type QASeverity = "fatal" | "error" | "warning";

export interface QAIssue {
  type: QAIssueType;
  severity: QASeverity;
  message: string;
  file?: string;
  line?: number;
  stack?: string;
  evidence?: string;
}

/** Hook fields every generated game must expose (platform contract). */
export const TEST_HOOK_REQUIRED_FIELDS = ["scene", "state", "score", "gameOver", "paused"] as const;

export function fatalCount(issues: QAIssue[]): number {
  return issues.filter((i) => i.severity === "fatal").length;
}
export function errorCount(issues: QAIssue[]): number {
  return issues.filter((i) => i.severity !== "warning").length;
}

/** Stable signature of the failure mode — used to detect a repair strategy that changed nothing. */
export function issueSignature(issues: QAIssue[]): string {
  return issues
    .filter((i) => i.severity !== "warning")
    .map((i) => `${i.type}:${i.message.slice(0, 80)}`)
    .sort()
    .join("|");
}

/** Issue types that are usually DOWNSTREAM symptoms when a fatal runtime/engine error exists. */
const CASCADE_TYPES: QAIssueType[] = ["interaction", "testHook", "visual"];

function renderIssue(i: QAIssue): string {
  const loc = i.file ? ` [${i.file}${i.line ? `:${i.line}` : ""}]` : "";
  const stack = i.stack ? `\n  stack: ${i.stack.split("\n").slice(0, 4).join(" | ")}` : "";
  const ev = i.evidence ? `\n  evidence: ${i.evidence.slice(0, 600)}` : "";
  return `- (${i.severity}/${i.type})${loc} ${i.message}${stack}${ev}`;
}

/**
 * Render issues as actionable evidence for the repair prompt. When a fatal
 * runtime/engine failure exists, downstream symptoms (no interaction, stale
 * hook, blank visuals) are explicitly separated so the model fixes the ROOT
 * cause first instead of redesigning interaction around a crash.
 */
export function formatIssues(issues: QAIssue[], max = 20): string {
  const ordered = [...issues].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)).slice(0, max);
  const hasFatalRoot = ordered.some((i) => i.severity === "fatal" && !CASCADE_TYPES.includes(i.type));
  if (!hasFatalRoot) return ordered.map(renderIssue).join("\n");
  const root = ordered.filter((i) => !CASCADE_TYPES.includes(i.type));
  const cascade = ordered.filter((i) => CASCADE_TYPES.includes(i.type));
  let out = `ROOT-CAUSE FAILURES (fix these FIRST — everything else is likely a consequence):\n${root.map(renderIssue).join("\n")}`;
  if (cascade.length) {
    out += `\n\nLIKELY DOWNSTREAM SYMPTOMS (probably caused by the fatal errors above — do NOT redesign these until the root cause is fixed):\n${cascade.map(renderIssue).join("\n")}`;
  }
  return out;
}

function sevRank(s: QASeverity): number {
  return s === "fatal" ? 0 : s === "error" ? 1 : 2;
}
