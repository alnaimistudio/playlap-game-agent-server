/**
 * Agent regression tests — deterministic static checks must catch the
 * common generated-code failure patterns observed in real runs.
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-ws-"));
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-data-"));
process.env.PLAYLAP_AGENT_API_KEY = process.env.PLAYLAP_AGENT_API_KEY || "test-key-12345678";

const { checkInfrastructure, staticEngineChecks, restoreInfrastructure, TEST_HELPER_SOURCE, TEST_HELPER_FILE } = await import(
  "../src/agent/staticChecks.js"
);
import type { Workspace } from "../src/agent/workspace.js";

function makeWs(engine: "phaser" | "babylon", files: Record<string, string>): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gas-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { jobId: "test", root, engine };
}

const GOOD_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
<script src="vendor/phaser.min.js"></script>
<script src="src/playlap-test.js"></script>
<script src="src/game.js"></script>
</body></html>`;

test("missing engine script in index.html is a fatal infrastructure issue", () => {
  const ws = makeWs("phaser", {
    "index.html": `<html><body><script src="src/game.js"></script></body></html>`,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": "__PLAYLAP_TEST_SET__({score:1});",
  });
  const issues = checkInfrastructure(ws);
  assert.ok(issues.some((i) => i.type === "infrastructure" && i.severity === "fatal" && /does not load/.test(i.message)));
});

test("game scripts loading before the engine is fatal", () => {
  const ws = makeWs("phaser", {
    "index.html": `<html><body><script src="src/game.js"></script><script src="vendor/phaser.min.js"></script></body></html>`,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": "__PLAYLAP_TEST_SET__({score:1});",
  });
  const issues = checkInfrastructure(ws);
  assert.ok(issues.some((i) => i.severity === "fatal" && /BEFORE/.test(i.message)));
});

test("restoreInfrastructure re-vendors a deleted engine file and helper", () => {
  const ws = makeWs("phaser", { "index.html": GOOD_HTML, "src/game.js": "__PLAYLAP_TEST_SET__({score:1});" });
  const notes = restoreInfrastructure(ws);
  assert.ok(notes.length >= 2, `expected restoration notes, got: ${notes.join(", ")}`);
  assert.ok(fs.statSync(path.join(ws.root, "vendor/phaser.min.js")).size > 100_000);
  assert.ok(fs.existsSync(path.join(ws.root, TEST_HELPER_FILE)));
});

test("duplicate Phaser texture keys are detected", () => {
  const ws = makeWs("phaser", {
    "index.html": GOOD_HTML,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": `
      this.load.image('fish-common', a());
      this.load.image('fish-rare', b());
      this.load.image('fish-common', c());
      __PLAYLAP_TEST_SET__({score:0});
    `,
  });
  const issues = staticEngineChecks(ws);
  const dup = issues.filter((i) => /registered more than once/.test(i.message));
  assert.strictEqual(dup.length, 1);
  assert.ok(dup[0].message.includes("fish-common"));
});

test("timer callback without Scene context is detected", () => {
  const ws = makeWs("phaser", {
    "index.html": GOOD_HTML,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": `
      this.time.addEvent({ delay: 1000, callback: this.updateTimer, loop: true });
      __PLAYLAP_TEST_SET__({score:0});
    `,
  });
  const issues = staticEngineChecks(ws);
  assert.ok(issues.some((i) => /callbackScope/.test(i.message)));
});

test("timer callback WITH callbackScope or arrow function passes", () => {
  const ws = makeWs("phaser", {
    "index.html": GOOD_HTML,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": `
      this.time.addEvent({ delay: 1000, callback: this.updateTimer, callbackScope: this, loop: true });
      this.time.addEvent({ delay: 500, callback: () => this.tick(), loop: true });
      __PLAYLAP_TEST_SET__({score:0});
    `,
  });
  const issues = staticEngineChecks(ws);
  assert.ok(!issues.some((i) => /callbackScope/.test(i.message)));
});

test("CDN dependencies in index.html are flagged", () => {
  const ws = makeWs("phaser", {
    "index.html": `<html><body><script src="https://cdn.jsdelivr.net/phaser.js"></script><script src="src/playlap-test.js"></script><script src="src/game.js"></script></body></html>`,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": "__PLAYLAP_TEST_SET__({score:0});",
  });
  const issues = staticEngineChecks(ws);
  assert.ok(issues.some((i) => /external network dependency/.test(i.message)));
});

test("game code that never updates the test contract is flagged", () => {
  const ws = makeWs("phaser", {
    "index.html": GOOD_HTML,
    "vendor/phaser.min.js": "x".repeat(20000),
    [TEST_HELPER_FILE]: TEST_HELPER_SOURCE,
    "src/game.js": "var x = 1;",
  });
  const issues = staticEngineChecks(ws);
  assert.ok(issues.some((i) => i.type === "testHook"));
});
