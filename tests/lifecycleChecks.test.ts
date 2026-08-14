/**
 * Agent regression tests — Phaser runtime/lifecycle failure class from a real
 * Qwen3-Coder job: scene APIs accessed with the wrong `this`/lifecycle phase
 * ("Cannot read properties of undefined (reading 'graphics')", "load context
 * not available in preload"). The system must (1) flag deterministic lifecycle
 * misuse statically, (2) map runtime exceptions to the exact generated source
 * expression, and (3) tell the repair model to fix the ROOT cause before
 * downstream symptoms like "no state change after input".
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-ws-"));
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-data-"));
process.env.PLAYLAP_AGENT_API_KEY = process.env.PLAYLAP_AGENT_API_KEY || "test-key-12345678";

const { phaserLifecycleChecks } = await import("../src/agent/staticChecks.js");
const { attachSourceEvidence } = await import("../src/agent/playtest.js");
const { formatIssues } = await import("../src/agent/qaTypes.js");
import type { QAIssue } from "../src/agent/qaTypes.js";

test("plain function callback using scene APIs via this is flagged", () => {
  const code = `class Main extends Phaser.Scene {
  create() {
    this.input.on('pointerdown', function () {
      var g = this.add.graphics();
      g.fillRect(0, 0, 10, 10);
    });
  }
}
`;
  const issues = phaserLifecycleChecks("src/game.js", code);
  const hit = issues.find((i) => /this.add/.test(i.message) && /NOT the Scene/.test(i.message));
  assert.ok(hit, `expected context-loss issue, got: ${JSON.stringify(issues)}`);
  assert.strictEqual(hit!.file, "src/game.js");
  assert.ok(hit!.line && hit!.line >= 3, "must point at the callback line");
});

test("arrow-function and bound callbacks are NOT flagged", () => {
  const code = `class Main extends Phaser.Scene {
  create() {
    this.input.on('pointerdown', () => { this.add.graphics(); });
    this.input.on('pointerup', function () { this.add.image(0, 0, 'x'); }.bind(this));
    this.input.on('pointermove', function () { this.add.circle(0, 0, 4); }, this);
    this.time.addEvent({ delay: 100, callback: function () { this.add.text(0,0,'x'); }, callbackScope: this });
  }
}
`;
  assert.deepStrictEqual(phaserLifecycleChecks("src/game.js", code), []);
});

test("setTimeout touching scene APIs is flagged", () => {
  const code = `function startWave(scene) {
  setTimeout(function () { this.physics.add.sprite(0, 0, 'fish'); }, 500);
}
`;
  const issues = phaserLifecycleChecks("src/waves.js", code);
  assert.ok(issues.some((i) => /setTimeout/.test(i.message) && /delayedCall/.test(i.message)));
});

test("this.load.* inside create() is flagged as lifecycle guidance", () => {
  const code = `class Main extends Phaser.Scene {
  preload() { this.load.image('bg', 'assets/bg.png'); }
  create() {
    this.load.image('fish', 'assets/fish.png');
    this.add.image(0, 0, 'bg');
  }
}
`;
  const issues = phaserLifecycleChecks("src/game.js", code);
  assert.ok(issues.some((i) => /this\.load\.image called inside create/.test(i.message)), JSON.stringify(issues));
});

test("creating display objects inside preload() is flagged as lifecycle guidance", () => {
  const code = `class Main extends Phaser.Scene {
  preload() {
    this.add.graphics().fillRect(0, 0, 10, 10);
  }
  create() {}
}
`;
  const issues = phaserLifecycleChecks("src/game.js", code);
  assert.ok(issues.some((i) => /preload\(\) creates game objects/.test(i.message)), JSON.stringify(issues));
});

test("correct lifecycle usage produces no findings", () => {
  const code = `class Main extends Phaser.Scene {
  preload() { this.load.image('bg', 'assets/bg.png'); }
  create() {
    this.add.image(0, 0, 'bg');
    this.time.delayedCall(500, () => this.spawnFish());
  }
  spawnFish() { this.physics.add.sprite(0, 0, 'fish'); }
  update() { __PLAYLAP_TEST_SET__({ score: this.score }); }
}
`;
  assert.deepStrictEqual(phaserLifecycleChecks("src/game.js", code), []);
});

test("attachSourceEvidence maps a runtime exception to the exact source expression", () => {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-evidence-"));
  const src = `var fisher;\nfunction cast() {\n  fisher.graphics.clear();\n}\ncast();\n`;
  fs.mkdirSync(path.join(buildDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(buildDir, "src", "game.js"), src);
  const issues: QAIssue[] = [
    { type: "runtime", severity: "fatal", message: "Cannot read properties of undefined (reading 'graphics')", file: "src/game.js", line: 3 },
  ];
  attachSourceEvidence(issues, buildDir);
  assert.ok(issues[0].evidence, "evidence must be attached");
  assert.ok(issues[0].evidence!.includes(">> 3| "), "offending line must be marked");
  assert.ok(issues[0].evidence!.includes("fisher.graphics.clear()"), "must contain the exact offending expression");
});

test("formatIssues separates root-cause failures from downstream symptoms", () => {
  const issues: QAIssue[] = [
    { type: "interaction", severity: "error", message: "no meaningful state change after simulated input" },
    { type: "runtime", severity: "fatal", message: "Cannot read properties of undefined (reading 'graphics')", file: "src/game.js", line: 3 },
    { type: "console", severity: "error", message: "Phaser load context not available in preload" },
  ];
  const out = formatIssues(issues);
  const rootIdx = out.indexOf("ROOT-CAUSE FAILURES");
  const cascadeIdx = out.indexOf("LIKELY DOWNSTREAM SYMPTOMS");
  assert.ok(rootIdx !== -1 && cascadeIdx !== -1, out);
  assert.ok(rootIdx < out.indexOf("reading 'graphics'") && out.indexOf("reading 'graphics'") < cascadeIdx, "fatal runtime error must be in the root section");
  assert.ok(out.indexOf("no meaningful state change") > cascadeIdx, "interaction issue must be in the downstream section");
});

test("without a fatal root, issues are NOT split into sections", () => {
  const issues: QAIssue[] = [
    { type: "interaction", severity: "error", message: "no meaningful state change after simulated input" },
  ];
  const out = formatIssues(issues);
  assert.ok(!out.includes("ROOT-CAUSE FAILURES"));
});

test("lifecycle heuristics are warnings — they must never block the final gate", () => {
  const code = `class Main extends Phaser.Scene {
  preload() { this.add.graphics(); }
  create() {
    this.load.image('x', 'a.png');
    this.input.on('pointerdown', function () { this.add.image(0, 0, 'x'); });
    setTimeout(function () { this.physics.add.sprite(0, 0, 'y'); }, 100);
  }
}
`;
  const issues = phaserLifecycleChecks("src/game.js", code);
  assert.ok(issues.length >= 3, JSON.stringify(issues));
  assert.ok(issues.every((i) => i.severity === "warning"), `heuristics must be warnings, got: ${JSON.stringify(issues.map((i) => i.severity))}`);
});

test("attachSourceEvidence refuses forged stack paths escaping the build dir", () => {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "gas-hostile-"));
  fs.mkdirSync(path.join(buildDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(buildDir, "src", "game.js"), "var ok = 1;\n");
  const secret = path.join(path.dirname(buildDir), `secret-${path.basename(buildDir)}.js`);
  fs.writeFileSync(secret, "var SECRET_TOKEN = 'do-not-leak';\n");
  const issues: QAIssue[] = [
    { type: "runtime", severity: "fatal", message: "forged", file: `src/../../${path.basename(secret)}`, line: 1 },
    { type: "runtime", severity: "fatal", message: "forged2", file: `../${path.basename(secret)}`, line: 1 },
    { type: "runtime", severity: "fatal", message: "outside allowlist", file: "node_modules/x.js", line: 1 },
    { type: "runtime", severity: "fatal", message: "legit", file: "src/game.js", line: 1 },
  ];
  attachSourceEvidence(issues, buildDir);
  assert.strictEqual(issues[0].evidence, undefined, "traversal path must be refused");
  assert.strictEqual(issues[1].evidence, undefined, "parent path must be refused");
  assert.strictEqual(issues[2].evidence, undefined, "non-allowlisted dir must be refused");
  assert.ok(issues[3].evidence?.includes("var ok = 1;"), "legitimate src path must still get evidence");
});
