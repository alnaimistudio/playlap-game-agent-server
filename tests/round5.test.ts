/**
 * Regression tests from REAL Qwen3-Coder run 9e36ff2c (fixtures included):
 *  1. Scene-construction diagnosis: `this.add` undefined inside create()
 *     must point the model at class inheritance/registration, not lifecycle moves.
 *  2. Repair scope: the real 362-line iteration-1 patch vs one pinpointed
 *     failure must be flagged as oversized.
 *  3. Model/protocol failures (Ollama 500 "XML syntax error") must be retried
 *     on a separate budget — never killing the job, never consuming QA repairs.
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-ws-"));

const { summarizeSceneConstruction, phaserSceneConstructionChecks } = await import("../src/agent/staticChecks.js");
const { attachConstructionEvidence } = await import("../src/agent/playtest.js");
const { analyzeRepairScope } = await import("../src/agent/qaTypes.js");
const { classifyModelError } = await import("../src/model/retry.js");
const { chatWithProtocolRetry } = await import("../src/agent/agent.js");
const { createWorkspace } = await import("../src/agent/workspace.js");
import type { QAIssue } from "../src/agent/qaTypes.js";
import type { ChatMessage, ChatResponse, ModelProvider, ToolDef } from "../src/model/provider.js";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "real-qwen-9e36ff2c");

// Exact architecture from the real failed run: a plain class with
// preload/create that is never a Phaser.Scene and is instantiated manually.
const NOT_A_SCENE = `class CatchTheCatchGame {
    constructor() {
        this.score = 0;
        this.currentScene = 'menu';
    }
    preload() {
    }
    create() {
        this.createFishingRodTexture();
    }
    createFishingRodTexture() {
        const graphics = this.add.graphics({ x: 0, y: 0 });
        graphics.fillRect(0, 0, 50, 10);
    }
}

window.addEventListener('load', () => {
    new CatchTheCatchGame();
});
`;

test("plain class with lifecycle methods is identified as NOT a Phaser.Scene", () => {
  const facts = summarizeSceneConstruction("src/game.js", NOT_A_SCENE);
  assert.ok(facts.some((f) => f.includes("CatchTheCatchGame") && f.includes("NOT a Phaser.Scene")), JSON.stringify(facts));
  assert.ok(facts.some((f) => f.includes("never boots it as a Scene")), "manual instantiation without Phaser.Game must be reported");

  const issues = phaserSceneConstructionChecks("src/game.js", NOT_A_SCENE);
  assert.ok(issues.length >= 1);
  assert.ok(issues.every((i) => i.severity === "warning"), "construction heuristics must not block the strict gate");
  assert.ok(issues[0].message.includes("do NOT move code between lifecycle methods"));
});

test("a correctly constructed Scene produces no construction complaints", () => {
  const good = `class Main extends Phaser.Scene {
  constructor() { super('main'); }
  preload() { this.load.image('x', 'assets/x.png'); }
  create() { this.add.image(0, 0, 'x'); }
}
new Phaser.Game({ scene: [Main] });
`;
  assert.deepStrictEqual(phaserSceneConstructionChecks("src/game.js", good), []);
  const facts = summarizeSceneConstruction("src/game.js", good);
  assert.ok(facts.some((f) => f.includes("extends: Phaser.Scene")));
});

test("runtime 'undefined (reading graphics)' gets SCENE CONSTRUCTION facts attached (real-run architecture)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-scene-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "game.js"), NOT_A_SCENE);
  const issues: QAIssue[] = [
    {
      type: "runtime",
      severity: "fatal",
      message: "Cannot read properties of undefined (reading 'graphics')",
      file: "src/game.js",
      line: 12,
      evidence: ">> 12| const graphics = this.add.graphics({ x: 0, y: 0 });",
    },
  ];
  attachConstructionEvidence(issues, dir);
  assert.ok(issues[0].evidence!.includes("SCENE CONSTRUCTION FACTS"), issues[0].evidence);
  assert.ok(issues[0].evidence!.includes("NOT a Phaser.Scene"));
  assert.ok(issues[0].evidence!.includes("no lifecycle move can ever fix this"));
});

test("REAL fixture: iteration-1 repair patch is flagged oversized vs its pinpointed evidence", () => {
  const diff = fs.readFileSync(path.join(FIXTURES, "repair-diff-iteration-1.patch"), "utf8");
  const qa1 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "qa-iteration-1.json"), "utf8"));
  const scope = analyzeRepairScope(diff, qa1.issues as QAIssue[]);
  assert.ok(scope.totalChangedLines > 100, `real patch is large, got ${scope.totalChangedLines}`);
  assert.ok(scope.evidenceFiles.includes("src/game.js"));
  assert.strictEqual(scope.oversized, true, "the real runaway rewrite must be flagged");
});

test("a small localized diff for pinpointed evidence is NOT flagged", () => {
  const diff = `diff --git a/src/game.js b/src/game.js
index 111..222 100644
--- a/src/game.js
+++ b/src/game.js
@@ -1,3 +1,3 @@
-class CatchTheCatchGame {
+class CatchTheCatchGame extends Phaser.Scene {
`;
  const issues: QAIssue[] = [{ type: "runtime", severity: "fatal", message: "x", file: "src/game.js", line: 1 }];
  assert.strictEqual(analyzeRepairScope(diff, issues).oversized, false);
});

test("model error classification", () => {
  assert.strictEqual(
    classifyModelError("Model API error HTTP 500: XML syntax error on line 25: element <function> closed by </parameter>"),
    "retryable",
  );
  assert.strictEqual(classifyModelError("Model API error HTTP 503: overloaded"), "retryable");
  assert.strictEqual(classifyModelError("fetch failed: ECONNRESET"), "retryable");
  assert.strictEqual(classifyModelError("The operation was aborted due to timeout"), "retryable");
  assert.strictEqual(classifyModelError("Model API error HTTP 401: invalid api key"), "fatal");
  assert.strictEqual(classifyModelError("Model API error HTTP 403: forbidden"), "fatal");
});

const MALFORMED = "Model API error HTTP 500: XML syntax error on line 25: element <function> closed by </parameter>";

const flakyProviderFactory = (failures: number, calls: string[]): ModelProvider => flakyProvider(failures, calls);

function flakyProvider(failures: number, calls: string[]): ModelProvider {
  let n = 0;
  return {
    name: "openai-compatible",
    modelName: "qwen3-coder:30b",
    async status() {
      return { ok: true, detail: "ready" };
    },
    async chat(_m: ChatMessage[], _t: ToolDef[]): Promise<ChatResponse> {
      calls.push(`call-${++n}`);
      if (n <= failures) throw new Error(MALFORMED);
      return { content: "recovered", toolCalls: [] };
    },
  } as ModelProvider;
}

test("first malformed model response does NOT kill the job — retried on its own budget, workspace untouched", async () => {
  const ws = createWorkspace(`retry-${Date.now()}`, "phaser");
  const before = fs.readFileSync(path.join(ws.root, "src", "playlap-test.js"), "utf8");
  const calls: string[] = [];
  const res = await chatWithProtocolRetry(flakyProvider(1, calls), ws, "repair-2", [{ role: "user", content: "x" }], []);
  assert.strictEqual(res.content, "recovered");
  assert.strictEqual(calls.length, 2, "provider must be retried exactly once");
  // evidence persisted for the failed attempt, with full classification detail
  const evPath = path.join(ws.root, "artifacts", "qa", "model-error-repair-2-attempt-1.json");
  assert.ok(fs.existsSync(evPath));
  const ev = JSON.parse(fs.readFileSync(evPath, "utf8"));
  assert.strictEqual(ev.phase, "repair-2");
  assert.strictEqual(ev.classification, "retryable");
  assert.strictEqual(ev.httpStatus, 500);
  assert.ok(ev.error.includes("XML syntax error"));
  assert.strictEqual(ev.workspaceRolledBack, false);
  // workspace untouched and nothing checkpointed
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "src", "playlap-test.js"), "utf8"), before);
});

test("repeated malformed responses fail cleanly after the protocol budget, with evidence for every attempt", async () => {
  const ws = createWorkspace(`retryfail-${Date.now()}`, "phaser");
  const calls: string[] = [];
  await assert.rejects(
    () => chatWithProtocolRetry(flakyProvider(99, calls), ws, "repair-1", [{ role: "user", content: "x" }], []),
    (err: Error) => err.message.includes("Model provider failed") && err.message.includes("model-error-repair-1"),
  );
  assert.ok(calls.length >= 2, "must retry before failing");
  const qaDir = path.join(ws.root, "artifacts", "qa");
  const evidence = fs.readdirSync(qaDir).filter((f) => f.startsWith("model-error-repair-1-attempt-"));
  assert.strictEqual(evidence.length, calls.length, "one evidence file per failed attempt");
});

test("fatal auth errors are NOT retried", async () => {
  const ws = createWorkspace(`retryauth-${Date.now()}`, "phaser");
  const calls: string[] = [];
  const provider: ModelProvider = {
    name: "openai-compatible",
    modelName: "m",
    async status() {
      return { ok: true, detail: "ready" };
    },
    async chat(): Promise<ChatResponse> {
      calls.push("call");
      throw new Error("Model API error HTTP 401: invalid api key");
    },
  } as ModelProvider;
  await assert.rejects(() => chatWithProtocolRetry(provider, ws, "coding-1", [{ role: "user", content: "x" }], []));
  assert.strictEqual(calls.length, 1, "auth failures must fail immediately");
});

test("scene declared in one file, registered in another → no false construction complaint", () => {
  const sceneFile = `class Main extends Phaser.Scene {
  constructor() { super('main'); }
  create() { this.add.text(0, 0, 'hi'); }
}
`;
  const bootFile = `new Phaser.Game({ scene: [Main] });\n`;
  const all = sceneFile + "\n" + bootFile;
  assert.deepStrictEqual(phaserSceneConstructionChecks("src/scene.js", sceneFile, all), []);
  const facts = summarizeSceneConstruction("src/scene.js", sceneFile, all);
  assert.ok(facts.some((f) => f.includes("registration found")), JSON.stringify(facts));
});

test("protocol failures on different tool-loop turns never overwrite each other's evidence", async () => {
  const ws = createWorkspace(`retryturns-${Date.now()}`, "phaser");
  const calls: string[] = [];
  await chatWithProtocolRetry(flakyProviderFactory(1, calls), ws, "repair-1-turn-1", [{ role: "user", content: "x" }], []);
  await chatWithProtocolRetry(flakyProviderFactory(1, calls), ws, "repair-1-turn-2", [{ role: "user", content: "x" }], []);
  const qaDir = path.join(ws.root, "artifacts", "qa");
  const files = fs.readdirSync(qaDir).filter((f) => f.startsWith("model-error-repair-1-turn-"));
  assert.deepStrictEqual(files.sort(), ["model-error-repair-1-turn-1-attempt-1.json", "model-error-repair-1-turn-2-attempt-1.json"]);
});

test("an expired job deadline stops protocol retries immediately", async () => {
  const ws = createWorkspace(`retryguard-${Date.now()}`, "phaser");
  const calls: string[] = [];
  let guardCalls = 0;
  const guard = (): void => {
    guardCalls++;
    if (guardCalls > 1) throw new Error("Job timed out");
  };
  await assert.rejects(
    () => chatWithProtocolRetry(flakyProviderFactory(99, calls), ws, "coding-1-turn-1", [{ role: "user", content: "x" }], [], guard),
    /Job timed out/,
  );
  assert.strictEqual(calls.length, 1, "no further provider calls after the deadline");
});
