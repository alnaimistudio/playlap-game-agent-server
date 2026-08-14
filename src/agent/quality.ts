/**
 * Quality gate — checks Build Health, Runtime Stability, Core Gameplay,
 * Intent Alignment (test hook + design doc), Mobile Controls, Visual
 * Usability and Performance sanity. Blockers prevent `completed`.
 */
import fs from "node:fs";
import path from "node:path";
import { Workspace, workspaceSizeMb } from "./workspace.js";
import { PlaytestReport } from "./playtest.js";
import { JobResult } from "../jobs.js";

export interface QualityVerdict {
  score: number; // 0..100
  checks: JobResult["qualityChecks"];
  blockers: string[];
}

export function evaluateQuality(ws: Workspace, report: PlaytestReport, polishNotes: string[]): QualityVerdict {
  const checks: JobResult["qualityChecks"] = {};
  const blockers: string[] = [];
  const add = (name: string, pass: boolean, note: string, blockerWhenFail = false): void => {
    checks[name] = { pass, note };
    if (!pass && blockerWhenFail) blockers.push(`${name}: ${note}`);
  };

  add("buildHealth", fs.existsSync(path.join(ws.root, "build", "index.html")), "production build present", true);
  add(
    "runtimeStability",
    report.pageErrors.length === 0 && report.consoleErrors.length === 0,
    report.pageErrors.concat(report.consoleErrors).slice(0, 3).join(" | ") || "no runtime errors",
    true,
  );
  add("coreGameplay", report.interactionEffect, report.interactionEffect ? "state responds to input" : "no state change after input", true);
  add("intentAlignment", report.testHook !== null && fs.existsSync(path.join(ws.root, "game-design.md")), report.testHook ? "test hook + design doc present" : "__PLAYLAP_TEST__ missing", true);
  add("visualUsability", report.canvasPresent && report.canvasPaintedRatio >= 0.05, `paint density ${report.canvasPaintedRatio.toFixed(2)}`, true);
  add("mobileControls", !polishNotes.some((n) => n.includes("no touch")), polishNotes.join("; ") || "touch handlers present");
  add("performanceSanity", workspaceSizeMb(ws) < 100, `workspace ${workspaceSizeMb(ws).toFixed(1)}MB`);

  const names = Object.keys(checks);
  const passed = names.filter((n) => checks[n].pass).length;
  const score = Math.round((passed / names.length) * 100);
  return { score, checks, blockers };
}
