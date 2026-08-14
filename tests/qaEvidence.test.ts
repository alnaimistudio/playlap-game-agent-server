/**
 * QA evidence architecture regression tests:
 *  - artifacts/ is git-ignored so rollback can NEVER delete iteration evidence
 *  - missing local assets are resolved to exact source references (root cause)
 *  - a repair that swaps one nonexistent filename for another is still flagged
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-ws-"));

const { createWorkspace, checkpoint, currentCommit, rollbackTo, rollbackToLastCheckpoint } = await import("../src/agent/workspace.js");
const { findLocalAssetReferences, localResourceChecks, assetExistsOnDisk } = await import("../src/agent/staticChecks.js");
const { missingResourceIssue } = await import("../src/agent/playtest.js");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

test("QA evidence in artifacts/ survives git rollback (reset --hard + clean)", () => {
  const ws = createWorkspace(`evidence-${Date.now()}`, "phaser");
  const qaDir = path.join(ws.root, "artifacts", "qa");
  fs.mkdirSync(qaDir, { recursive: true });

  // iteration 1 evidence, then a checkpoint
  fs.writeFileSync(path.join(qaDir, "qa-iteration-1.json"), "{\"iteration\":1}");
  fs.writeFileSync(path.join(ws.root, "src", "game.js"), "var v = 1;\n");
  checkpoint(ws, "iteration 1");
  const goodCommit = currentCommit(ws)!;

  // iteration 2 + 3 evidence written AFTER the checkpoint, then a bad repair
  fs.writeFileSync(path.join(qaDir, "qa-iteration-2.json"), "{\"iteration\":2}");
  fs.writeFileSync(path.join(qaDir, "repair-input-iteration-2.txt"), "prompt sent to model");
  fs.writeFileSync(path.join(qaDir, "repair-diff-iteration-2.patch"), "diff --git a b");
  fs.writeFileSync(path.join(ws.root, "src", "game.js"), "var v = 2; // bad repair\n");
  checkpoint(ws, "bad repair");
  fs.writeFileSync(path.join(qaDir, "qa-iteration-3.json"), "{\"iteration\":3}");

  // artifacts/ must never be tracked by git
  const tracked = git(ws.root, ["ls-files"]);
  assert.ok(!tracked.includes("artifacts/"), `artifacts/ must be git-ignored, tracked files:\n${tracked}`);

  // rollback both ways — every evidence file must survive
  rollbackTo(ws, goodCommit);
  rollbackToLastCheckpoint(ws);
  for (const f of [
    "qa-iteration-1.json",
    "qa-iteration-2.json",
    "qa-iteration-3.json",
    "repair-input-iteration-2.txt",
    "repair-diff-iteration-2.patch",
  ]) {
    assert.ok(fs.existsSync(path.join(qaDir, f)), `${f} must survive rollback`);
  }
  // and the code rollback itself worked
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "src", "game.js"), "utf8"), "var v = 1;\n");
});

function makeGameDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-res-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<script src="src/game.js"></script>\n`);
  fs.writeFileSync(path.join(dir, "assets", "boat.png"), "png");
  fs.writeFileSync(
    path.join(dir, "src", "game.js"),
    [
      `class Main extends Phaser.Scene {`,
      `  preload() {`,
      `    this.load.image("water", "assets/water.png");`,
      `    this.load.image("boat", "assets/boat.png");`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  return dir;
}

test("pre-playtest validation maps a missing asset to its exact source reference", () => {
  const dir = makeGameDir();
  const refs = findLocalAssetReferences(dir);
  assert.ok(refs.some((r) => r.assetPath === "assets/water.png" && r.file === path.join("src", "game.js") && r.line === 3));

  const issues = localResourceChecks(dir);
  assert.strictEqual(issues.length, 1, JSON.stringify(issues)); // boat.png exists → not flagged
  const issue = issues[0];
  assert.strictEqual(issue.type, "resource");
  assert.strictEqual(issue.severity, "fatal"); // root cause, blocks before Chromium
  assert.ok(issue.message.includes("assets/water.png"));
  const detail = JSON.parse(issue.evidence!);
  assert.strictEqual(detail.existsOnDisk, false);
  assert.strictEqual(detail.normalizedWorkspacePath, "assets/water.png");
  assert.ok(detail.referencedBy[0].sourceLine.includes(`this.load.image("water", "assets/water.png")`));
});

test("a repair that swaps the reference to ANOTHER nonexistent file is still rejected", () => {
  const dir = makeGameDir();
  const gamePath = path.join(dir, "src", "game.js");
  fs.writeFileSync(gamePath, fs.readFileSync(gamePath, "utf8").replace("assets/water.png", "assets/ocean.png"));
  const issues = localResourceChecks(dir);
  assert.strictEqual(issues.length, 1);
  assert.ok(issues[0].message.includes("assets/ocean.png"), "the new invented filename must be flagged");
  assert.strictEqual(issues[0].severity, "fatal");
});

test("a repair that points the reference at an existing file passes validation", () => {
  const dir = makeGameDir();
  const gamePath = path.join(dir, "src", "game.js");
  fs.writeFileSync(gamePath, fs.readFileSync(gamePath, "utf8").replace("assets/water.png", "assets/boat.png"));
  // duplicate-key checks live elsewhere; resource validation itself must pass
  assert.deepStrictEqual(localResourceChecks(dir), []);
});

test("browser 404 issue is enriched with workspace path, existence, and referencedBy", () => {
  const dir = makeGameDir();
  const issue = missingResourceIssue(dir, "/assets/water.png", "HTTP 404");
  assert.strictEqual(issue.severity, "fatal");
  assert.strictEqual(issue.file, path.join("src", "game.js"));
  assert.strictEqual(issue.line, 3);
  const detail = JSON.parse(issue.evidence!);
  assert.strictEqual(detail.requestedUrl, "/assets/water.png");
  assert.strictEqual(detail.existsOnDisk, false);
  assert.strictEqual(detail.referencedBy.length, 1);
  assert.ok(issue.message.includes("NEVER swap it for another nonexistent filename"));

  // existing file that merely failed for another reason stays an error, not fatal
  const ok = missingResourceIssue(dir, "/assets/boat.png", "failed to load (net::ERR_ABORTED)");
  assert.strictEqual(ok.severity, "error");
  assert.strictEqual(JSON.parse(ok.evidence!).existsOnDisk, true);
});

test("ambiguous quoted asset strings are warnings; only proven load sinks are fatal", () => {
  const dir = makeGameDir();
  fs.writeFileSync(
    path.join(dir, "src", "notes.js"),
    [
      `/* the art lives in "assets/ghost.png" eventually */`,
      `var plannedArt = "assets/unused-idea.png"; // never loaded`,
      ``,
    ].join("\n"),
  );
  const issues = localResourceChecks(dir);
  const fatal = issues.filter((i) => i.severity === "fatal");
  const warn = issues.filter((i) => i.severity === "warning");
  assert.strictEqual(fatal.length, 1, JSON.stringify(issues)); // only the real this.load.image miss
  assert.ok(fatal[0].message.includes("assets/water.png"));
  assert.ok(warn.every((i) => !i.message.includes("assets/ghost.png")), "block-comment content must not be scanned");
  assert.ok(warn.some((i) => i.message.includes("assets/unused-idea.png")), "ambiguous string is advisory only");
});

test("nested src modules are scanned recursively", () => {
  const dir = makeGameDir();
  fs.mkdirSync(path.join(dir, "src", "scenes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "scenes", "deep.js"), `this.load.image("bg", "assets/deep-bg.png");\n`);
  const issues = localResourceChecks(dir);
  assert.ok(issues.some((i) => i.severity === "fatal" && i.message.includes("assets/deep-bg.png")));
});

test("traversal asset paths are contained and never probed outside the workspace", () => {
  const dir = makeGameDir();
  assert.strictEqual(assetExistsOnDisk(dir, "assets/../../etc/passwd"), false);
  assert.strictEqual(assetExistsOnDisk(dir, "assets"), false, "directories are not files");
  assert.strictEqual(assetExistsOnDisk(dir, "assets/boat.png"), true);
});
