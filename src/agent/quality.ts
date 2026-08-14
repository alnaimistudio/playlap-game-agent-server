/**
 * Final quality gate — a game may only become `completed` when the engine
 * loaded, something renders, there are no fatal runtime errors, the
 * __PLAYLAP_TEST__ contract is honored, meaningful interaction works, the
 * build is self-contained/offline and mobile controls exist.
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

  const fatal = report.issues.filter((i) => i.severity === "fatal");
  add("buildHealth", fs.existsSync(path.join(ws.root, "build", "index.html")), "production build present", true);
  add(
    "engineLoaded",
    report.engineLoaded,
    report.engineLoaded ? "engine global present after load" : "engine failed to load (infrastructure)",
    true,
  );
  add(
    "runtimeStability",
    report.pageErrors.length === 0 && report.consoleErrors.length === 0 && fatal.filter((i) => i.type === "runtime").length === 0,
    report.pageErrors.concat(report.consoleErrors).slice(0, 3).join(" | ") || "no runtime errors",
    true,
  );
  add(
    "coreGameplay",
    report.interactionEffect,
    report.interactionEffect
      ? `state responds to input (changed: ${report.changedHookFields.join(", ") || "visual"})`
      : "no state change after input",
    true,
  );
  add(
    "intentAlignment",
    report.hookContractOk && fs.existsSync(path.join(ws.root, "game-design.md")),
    report.testHook === null
      ? "__PLAYLAP_TEST__ missing"
      : report.missingHookFields.length > 0
        ? `hook missing fields: ${report.missingHookFields.join(", ")}`
        : "test hook contract + design doc present",
    true,
  );
  add(
    "selfContained",
    report.blockedExternal.length === 0,
    report.blockedExternal.length === 0 ? "no external network dependencies" : `external requests: ${report.blockedExternal.slice(0, 2).join(", ")}`,
    true,
  );
  add("visualUsability", report.canvasPresent && report.canvasPaintedRatio >= 0.05, `paint density ${report.canvasPaintedRatio.toFixed(2)}`, true);
  const staticBad = report.issues.filter((i) => (i.type === "static" || i.type === "infrastructure") && i.severity !== "warning");
  add(
    "staticChecks",
    staticBad.length === 0,
    staticBad.length === 0 ? "no static/infrastructure findings" : staticBad.slice(0, 3).map((i) => i.message.slice(0, 80)).join(" | "),
    true,
  );
  add("mobileControls", !polishNotes.some((n) => n.includes("no touch")), polishNotes.join("; ") || "touch handlers present");
  add("performanceSanity", workspaceSizeMb(ws) < 100, `workspace ${workspaceSizeMb(ws).toFixed(1)}MB`);

  const names = Object.keys(checks);
  const passed = names.filter((n) => checks[n].pass).length;
  const score = Math.round((passed / names.length) * 100);
  return { score, checks, blockers };
}
