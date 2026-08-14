/**
 * Agent regression tests — reproduces the real-world failure class:
 * a QA repair introduces malformed JavaScript (e.g. a stray `score: score,`
 * outside an object literal). The agent must detect it immediately, give the
 * model exact file/line/nearby-source evidence in a focused syntax-fix round
 * (separate from the runtime repair budget), and revert the repair if the
 * syntax cannot be restored — valid code must never end up replaced by
 * invalid code.
 */
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.WORKSPACES_DIR = process.env.WORKSPACES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-ws-"));
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "gas-test-data-"));
process.env.PLAYLAP_AGENT_API_KEY = process.env.PLAYLAP_AGENT_API_KEY || "test-key-12345678";

const { checkJsSyntax } = await import("../src/agent/agent.js");
const { executeTool } = await import("../src/agent/tools.js");
const { createWorkspace, checkpoint, currentCommit, rollbackTo } = await import("../src/agent/workspace.js");
import type { Workspace } from "../src/agent/workspace.js";

const VALID_GAME = `var score = 0;
function updateHook() {
  __PLAYLAP_TEST_SET__({ scene: "main", state: "play", score: score, gameOver: false, paused: false });
}
updateHook();
`;

// The malformed-property class from the real Qwen3-Coder failure: a
// `score: score,` property left in an unterminated object literal.
const BROKEN_GAME = `var score = 0;
var hookState = {
  score: score,
;
updateHook();
`;

function makeWs(files: Record<string, string>): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gas-syntax-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { jobId: "test", root, engine: "phaser" };
}

test("checkJsSyntax passes valid generated game code", () => {
  const ws = makeWs({ "src/fishing-game.js": VALID_GAME });
  assert.strictEqual(checkJsSyntax(ws), null);
});

test("checkJsSyntax reports file, line and nearby source for malformed property syntax", () => {
  const ws = makeWs({ "src/fishing-game.js": BROKEN_GAME });
  const err = checkJsSyntax(ws);
  assert.ok(err, "expected a syntax error");
  assert.ok(err!.includes("src/fishing-game.js"), "must name the file");
  assert.ok(/line \d+/.test(err!), "must include the line number");
  assert.ok(err!.includes("score: score,"), "must include the offending source");
  assert.ok(err!.includes(">>"), "must mark the offending line in nearby source");
});

test("write_file tool warns about a syntax error in the same tool result", async () => {
  const ws = makeWs({});
  const out = await executeTool(ws, "write_file", { path: "src/game.js", content: BROKEN_GAME });
  assert.ok(out.includes("SYNTAX ERROR"), `expected inline syntax warning, got: ${out}`);
  const ok = await executeTool(ws, "write_file", { path: "src/game.js", content: VALID_GAME });
  assert.ok(!ok.includes("SYNTAX ERROR"), "valid content must not warn");
});

test("edit_file tool warns when an edit breaks previously valid code", async () => {
  const ws = makeWs({ "src/game.js": VALID_GAME });
  const out = await executeTool(ws, "edit_file", {
    path: "src/game.js",
    find: "updateHook();",
    replace: "var hookState = {\n  score: score,\n;\nupdateHook();",
  });
  assert.ok(out.includes("SYNTAX ERROR"), `expected inline syntax warning, got: ${out}`);
});

test("a repair that breaks syntax can be fully reverted to the pre-repair commit", () => {
  const ws = createWorkspace(`syntax-revert-${Date.now()}`, "phaser");
  fs.writeFileSync(path.join(ws.root, "src", "game.js"), VALID_GAME);
  checkpoint(ws, "valid game");
  const preRepair = currentCommit(ws);
  assert.ok(preRepair, "workspace must have a commit");
  assert.strictEqual(checkJsSyntax(ws), null);

  // Simulated bad repair: valid file replaced by malformed code.
  fs.writeFileSync(path.join(ws.root, "src", "game.js"), BROKEN_GAME);
  assert.ok(checkJsSyntax(ws), "broken code must be detected");

  rollbackTo(ws, preRepair!);
  assert.strictEqual(checkJsSyntax(ws), null, "revert must restore parseable code");
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "src", "game.js"), "utf8"), VALID_GAME);
});
