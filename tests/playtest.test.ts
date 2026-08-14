/**
 * Agent regression tests — the browser QA must correctly classify broken
 * games and give the repair agent actionable evidence (stack traces, files,
 * lines, hook state before/after).
 *
 * These tests run a real headless Chromium. On hosts where the sandbox
 * cannot start, set CHROMIUM_NO_SANDBOX=1 (dev) / ALLOW_NO_SANDBOX=1.
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-ws-"));
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-data-"));
process.env.PLAYLAP_AGENT_API_KEY = process.env.PLAYLAP_AGENT_API_KEY || "test-key-12345678";

const { playtest, probeBrowser } = await import("../src/agent/playtest.js");
const { TEST_HELPER_SOURCE } = await import("../src/agent/staticChecks.js");
import type { Workspace } from "../src/agent/workspace.js";

const probe = await probeBrowser();
const skip = probe.ok ? false : `browser unavailable: ${probe.detail}`;

function makeBuild(engine: "phaser" | "babylon", files: Record<string, string>): { ws: Workspace; buildDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gas-playtest-"));
  const buildDir = path.join(root, "build");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(buildDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { ws: { jobId: "test", root, engine }, buildDir };
}

/** Minimal self-contained "game" page (canvas drawing, no engine). */
function page(body: string, scripts: string[] = ["src/playlap-test.js", "src/game.js"]): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">${body}${scripts.map((s) => `<script src="${s}"></script>`).join("")}</body></html>`;
}

const NOISY_CANVAS = `
var cv = document.createElement('canvas'); cv.width = 402; cv.height = 874; document.body.appendChild(cv);
var ctx = cv.getContext('2d');
function noise() {
  for (var i = 0; i < 4000; i++) {
    ctx.fillStyle = 'rgb(' + ((i*97)%255) + ',' + ((i*57)%255) + ',' + ((i*13)%255) + ')';
    ctx.fillRect((i * 37) % 402, (i * 71) % 874, 6, 6);
  }
}
noise();
window.Phaser = window.Phaser || { FAKE: true }; // engine marker for fixtures
`;

test("runtime exception is captured with stack evidence", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>"),
    "src/playlap-test.js": TEST_HELPER_SOURCE,
    "src/game.js": `${NOISY_CANVAS}
__PLAYLAP_TEST_SET__({ scene: 'main', state: 'play' });
setTimeout(function () { var scene; scene.time.addEvent({}); }, 400);`,
  });
  const report = await playtest(ws, buildDir, "t-runtime", 1);
  assert.strictEqual(report.ok, false);
  const runtime = report.issues.find((i) => i.type === "runtime" && /reading 'time'|undefined/.test(i.message));
  assert.ok(runtime, `expected runtime issue, got: ${JSON.stringify(report.issues.map((i) => i.message))}`);
  assert.ok(runtime!.stack, "runtime issue must carry a stack trace");
  // QA artifacts persisted
  assert.ok(fs.existsSync(path.join(ws.root, "artifacts/qa/qa-iteration-1.json")));
  assert.ok(fs.existsSync(path.join(ws.root, "artifacts/qa/console-iteration-1.log")));
});

test("missing __PLAYLAP_TEST__ hook is a fatal contract violation", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>", ["src/game.js"]),
    "src/game.js": NOISY_CANVAS,
  });
  const report = await playtest(ws, buildDir, "t-hook", 1);
  assert.strictEqual(report.ok, false);
  assert.ok(report.issues.some((i) => i.type === "testHook" && i.severity === "fatal"));
});

test("hook missing required contract fields is reported", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>", ["src/game.js"]),
    "src/game.js": `${NOISY_CANVAS}\nwindow.__PLAYLAP_TEST__ = { score: 1 };`,
  });
  const report = await playtest(ws, buildDir, "t-fields", 1);
  assert.ok(report.missingHookFields.includes("scene"));
  assert.ok(report.issues.some((i) => i.type === "testHook" && /missing required fields/.test(i.message)));
});

test("input that changes nothing produces an interaction issue with before/after evidence", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>"),
    "src/playlap-test.js": TEST_HELPER_SOURCE,
    "src/game.js": `${NOISY_CANVAS}\n__PLAYLAP_TEST_SET__({ scene: 'main', state: 'play' });`,
  });
  const report = await playtest(ws, buildDir, "t-static-game", 1);
  assert.strictEqual(report.ok, false);
  const issue = report.issues.find((i) => i.type === "interaction");
  assert.ok(issue, "expected an interaction issue");
  assert.ok(issue!.evidence?.includes("hook before"), "interaction issue must include before/after evidence");
});

test("interactive game with live hook passes QA", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>"),
    "src/playlap-test.js": TEST_HELPER_SOURCE,
    "src/game.js": `${NOISY_CANVAS}
var score = 0;
__PLAYLAP_TEST_SET__({ scene: 'main', state: 'play' });
function bump() { score++; noise(); __PLAYLAP_TEST_SET__({ score: score, state: 'playing' }); }
document.addEventListener('pointerdown', bump);
document.addEventListener('touchstart', bump);
document.addEventListener('keydown', bump);`,
  });
  const report = await playtest(ws, buildDir, "t-good", 1);
  assert.strictEqual(report.ok, true, `expected pass, issues: ${JSON.stringify(report.issues.map((i) => i.message))}`);
  assert.ok(report.changedHookFields.includes("score"));
});

test("lifecycle exception is mapped to exact generated source line with snippet", { skip }, async () => {
  const { ws, buildDir } = makeBuild("phaser", {
    "index.html": page("<div></div>"),
    "src/playlap-test.js": TEST_HELPER_SOURCE,
    "src/game.js": `${NOISY_CANVAS}
__PLAYLAP_TEST_SET__({ scene: 'main', state: 'play' });
var fisher;
fisher.graphics.clear();`,
  });
  const report = await playtest(ws, buildDir, "t-lifecycle", 1);
  assert.strictEqual(report.ok, false);
  const runtime = report.issues.find((i) => i.type === "runtime" && /reading 'graphics'/.test(i.message));
  assert.ok(runtime, `expected runtime issue, got: ${JSON.stringify(report.issues.map((i) => i.message))}`);
  assert.strictEqual(runtime!.file, "src/game.js");
  assert.ok(runtime!.line, "must carry a line number");
  assert.ok(runtime!.evidence?.includes("fisher.graphics.clear()"), `evidence must contain the offending expression, got: ${runtime!.evidence}`);
});
