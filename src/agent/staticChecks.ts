/**
 * Deterministic, engine-specific checks that run BEFORE the browser playtest.
 * Two categories:
 *  - Infrastructure: required bootstrap files (vendor engine, script order,
 *    test-hook helper). Broken infrastructure is repaired deterministically
 *    (restoreInfrastructure) instead of asking the model to rewrite it.
 *  - Static engine checks: cheap pattern detection of common generated-code
 *    mistakes (duplicate texture keys, timer callbacks losing Scene context,
 *    CDN dependencies, missing __PLAYLAP_TEST__). They complement — never
 *    replace — runtime QA.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { Workspace } from "./workspace.js";
import { QAIssue } from "./qaTypes.js";

const VENDOR: Record<Workspace["engine"], { file: string; from: string; global: string }> = {
  phaser: { file: "vendor/phaser.min.js", from: "node_modules/phaser/dist/phaser.min.js", global: "Phaser" },
  babylon: { file: "vendor/babylon.js", from: "node_modules/babylonjs/babylon.js", global: "BABYLON" },
};

export const TEST_HELPER_FILE = "src/playlap-test.js";

/** Reusable platform test-hook helper — scaffolded into every workspace so the model composes with it instead of reinventing the contract. */
export const TEST_HELPER_SOURCE = `// Play Lap platform testing contract — DO NOT DELETE THIS FILE.
// Exposes window.__PLAYLAP_TEST__ and a safe updater. Populate it from game
// code with __PLAYLAP_TEST_SET__({ scene, state, score, gameOver, paused, ... }).
(function () {
  var s = { scene: null, state: "boot", score: 0, gameOver: false, paused: false };
  window.__PLAYLAP_TEST__ = s;
  window.__PLAYLAP_TEST_SET__ = function (patch) {
    if (patch && typeof patch === "object") { for (var k in patch) s[k] = patch[k]; }
    return s;
  };
})();
`;

function listJsFiles(ws: Workspace): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  walk(path.join(ws.root, "src"));
  return out;
}

/**
 * Verify required bootstrap infrastructure; where possible fix it
 * deterministically (re-vendor the engine, restore the helper, fix script
 * order hints are left to issues). Returns notes for the applied fixes.
 */
export function restoreInfrastructure(ws: Workspace): string[] {
  const notes: string[] = [];
  const vendor = VENDOR[ws.engine];
  const vendorPath = path.join(ws.root, vendor.file);
  const from = path.join(config.serverRoot, vendor.from);
  // Integrity, not just presence: restore canonical bytes if the model
  // touched the vendored engine (size mismatch is a cheap, reliable proxy).
  if (!fs.existsSync(vendorPath) || (fs.existsSync(from) && fs.statSync(vendorPath).size !== fs.statSync(from).size)) {
    fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
    fs.copyFileSync(from, vendorPath);
    notes.push(`restored engine file ${vendor.file} to canonical version`);
  }
  const helperPath = path.join(ws.root, TEST_HELPER_FILE);
  if (!fs.existsSync(helperPath) || fs.readFileSync(helperPath, "utf8") !== TEST_HELPER_SOURCE) {
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, TEST_HELPER_SOURCE);
    notes.push(`restored ${TEST_HELPER_FILE} to canonical version`);
  }
  return notes;
}

/** Infrastructure verification (after restoration) — fatal issues only. */
export function checkInfrastructure(ws: Workspace): QAIssue[] {
  const issues: QAIssue[] = [];
  const vendor = VENDOR[ws.engine];
  const indexPath = path.join(ws.root, "index.html");
  if (!fs.existsSync(indexPath)) {
    issues.push({ type: "infrastructure", severity: "fatal", message: "index.html is missing at workspace root" });
    return issues;
  }
  const html = fs.readFileSync(indexPath, "utf8");
  const scripts = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const vendorIdx = scripts.findIndex((s) => s.replace(/^\.\//, "").includes(path.basename(vendor.file)));
  if (vendorIdx === -1) {
    issues.push({
      type: "infrastructure",
      severity: "fatal",
      file: "index.html",
      message: `index.html does not load ${vendor.file} — the engine will be undefined`,
      evidence: `script tags found: ${scripts.join(", ") || "(none)"}`,
    });
  } else {
    const firstGameIdx = scripts.findIndex((s) => s.includes("src/") && !s.includes(path.basename(TEST_HELPER_FILE)));
    if (firstGameIdx !== -1 && firstGameIdx < vendorIdx) {
      issues.push({
        type: "infrastructure",
        severity: "fatal",
        file: "index.html",
        message: `game scripts load BEFORE ${vendor.file}; move the engine <script> first`,
        evidence: `order: ${scripts.join(" → ")}`,
      });
    }
  }
  if (!scripts.some((s) => s.includes(path.basename(TEST_HELPER_FILE)))) {
    issues.push({
      type: "infrastructure",
      severity: "error",
      file: "index.html",
      message: `index.html must load ${TEST_HELPER_FILE} (platform test contract) before other src/ scripts`,
    });
  }
  return issues;
}

/** Cheap deterministic engine-specific checks over generated code. */
export function staticEngineChecks(ws: Workspace): QAIssue[] {
  const issues: QAIssue[] = [];
  const files = listJsFiles(ws).filter((f) => !f.endsWith(path.basename(TEST_HELPER_FILE)));
  const rel = (f: string): string => path.relative(ws.root, f);

  // External network dependencies (games must be self-contained/offline)
  const indexPath = path.join(ws.root, "index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf8");
    for (const m of html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)) {
      issues.push({
        type: "static",
        severity: "error",
        file: "index.html",
        message: `external network dependency: ${m[1].slice(0, 100)} — vendor it locally, no CDN allowed`,
      });
    }
  }

  let hookSeen = false;
  const textureKeys = new Map<string, string>(); // key → first location

  for (const f of files) {
    const code = fs.readFileSync(f, "utf8");
    const lines = code.split("\n");
    if (/__PLAYLAP_TEST__|__PLAYLAP_TEST_SET__/.test(code)) hookSeen = true;

    lines.forEach((line, i) => {
      // Duplicate texture/asset keys (Phaser)
      if (ws.engine === "phaser") {
        const load = line.match(/\b(?:this|scene)\.load\.(?:image|spritesheet|atlas|audio|bitmapFont)\(\s*['"]([\w.-]+)['"]/);
        const gen = line.match(/\btextures\.(?:addBase64|generate|addCanvas)\(\s*['"]([\w.-]+)['"]/);
        const key = load?.[1] ?? gen?.[1];
        if (key) {
          const where = `${rel(f)}:${i + 1}`;
          const first = textureKeys.get(key);
          if (first) {
            issues.push({
              type: "static",
              severity: "error",
              file: rel(f),
              line: i + 1,
              message: `texture/asset key "${key}" registered more than once (first at ${first}) — "Texture key already in use"`,
            });
          } else textureKeys.set(key, where);
        }
      }
      if (/https?:\/\//.test(line) && /fetch\(|XMLHttpRequest|import\(|\.src\s*=/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        issues.push({
          type: "static",
          severity: "warning",
          file: rel(f),
          line: i + 1,
          message: "possible external network access — games must be fully offline",
          evidence: line.trim().slice(0, 160),
        });
      }
    });

    // Timer/event callbacks that may lose Scene context (Phaser)
    if (ws.engine === "phaser") {
      for (const m of code.matchAll(/\.(?:time\.addEvent|addEvent)\s*\(\s*\{([^}]*)\}/gs)) {
        const body = m[1];
        const usesMethod = /callback\s*:\s*this\.\w+/.test(body);
        const bound = /callbackScope\s*:\s*this|\.bind\(\s*this\s*\)|callback\s*:\s*\(\s*\)?\s*=>/.test(body);
        if (usesMethod && !bound) {
          const line = code.slice(0, m.index).split("\n").length;
          issues.push({
            type: "static",
            severity: "error",
            file: rel(f),
            line,
            message: "time.addEvent callback uses an instance method without callbackScope: this (Scene context will be lost)",
            evidence: body.trim().slice(0, 200),
          });
        }
      }
    }
  }

  if (ws.engine === "phaser") {
    for (const f of files) issues.push(...phaserLifecycleChecks(rel(f), fs.readFileSync(f, "utf8")));
  }

  if (!hookSeen) {
    issues.push({
      type: "testHook",
      severity: "error",
      message: `no game code updates the test contract — call __PLAYLAP_TEST_SET__({scene,state,score,gameOver,paused,...}) from ${ws.engine === "phaser" ? "your Scene" : "your game loop"}`,
    });
  }
  return issues;
}

/** Scene-owned API roots that require `this` to actually be the Scene. */
const SCENE_API = /\bthis\.(add|load|physics|anims|tweens|time|input|cameras|sound|textures|make|scene)\b/;

/** Extract a function body by brace matching starting at the `{` after `start`. */
function functionBody(code: string, start: number): { body: string; from: number } | null {
  const open = code.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return { body: code.slice(open + 1, i), from: open + 1 };
    }
  }
  return null;
}

const lineAt = (code: string, index: number): number => code.slice(0, index).split("\n").length;

/**
 * Heuristic Phaser lifecycle/context checks — the failure class observed in
 * real generations: scene APIs accessed where `this` is not the Scene
 * (plain-function callbacks) or in the wrong lifecycle phase.
 *
 * IMPORTANT: these are regex/brace heuristics, not an AST — they can both
 * miss violations and flag valid code (e.g. unusual scoping patterns). They
 * are therefore emitted as severity "warning": rich evidence for the coding
 * and repair prompts, but NEVER completion blockers. Real lifecycle bugs
 * still block via their runtime exceptions in the browser playtest.
 */
export function phaserLifecycleChecks(relFile: string, code: string): QAIssue[] {
  const issues: QAIssue[] = [];

  // 1. Plain `function` callbacks that use scene APIs via `this` — `this` is
  //    NOT the Scene inside them (setTimeout, forEach, on(), tween callbacks…)
  //    unless explicitly bound. This is the direct cause of
  //    "Cannot read properties of undefined (reading 'graphics'/'image')".
  for (const m of code.matchAll(/[(,]\s*function\s*\([^)]*\)\s*\{/g)) {
    const fb = functionBody(code, m.index + m[0].length - 1);
    if (!fb) continue;
    const api = fb.body.match(SCENE_API);
    if (!api) continue;
    const tail = code.slice(fb.from + fb.body.length, fb.from + fb.body.length + 60);
    if (/^\s*\}\s*\.bind\(\s*this\s*\)/.test(tail)) continue;
    // Emitter-scope argument (`on('x', fn, this)`) also preserves context.
    if (/^\s*\}\s*,\s*this\s*\)/.test(tail)) continue;
    // callbackScope: this in the same options object also preserves context
    const surrounding = code.slice(Math.max(0, m.index - 200), fb.from + fb.body.length + 200);
    if (/callbackScope\s*:\s*this/.test(surrounding)) continue;
    issues.push({
      type: "static",
      severity: "warning",
      file: relFile,
      line: lineAt(code, m.index),
      message: `plain function callback uses "this.${api[1]}" but "this" is NOT the Scene inside a plain function — use an arrow function, .bind(this), or callbackScope: this`,
      evidence: fb.body.trim().split("\n").slice(0, 4).join("\n").slice(0, 300),
    });
  }

  // 2. setTimeout/setInterval touching Scene APIs — page timers lose Scene
  //    context and survive scene restarts; use this.time.delayedCall/addEvent.
  for (const m of code.matchAll(/\b(setTimeout|setInterval)\s*\(/g)) {
    const fb = functionBody(code, m.index);
    const snippet = fb?.body ?? code.slice(m.index, m.index + 200);
    if (SCENE_API.test(snippet)) {
      issues.push({
        type: "static",
        severity: "warning",
        file: relFile,
        line: lineAt(code, m.index),
        message: `${m[1]} callback touches Scene APIs — use this.time.delayedCall/addEvent instead (page timers lose Scene context and survive scene restarts)`,
        evidence: snippet.trim().slice(0, 200),
      });
    }
  }

  // 3. Loading assets outside preload(): this.load.* in create()/update()
  //    never runs without an explicit loader start — a lifecycle misuse.
  for (const name of ["create", "update"]) {
    const decl = code.match(new RegExp(`(?:^|[\\s;])${name}\\s*\\([^)]*\\)\\s*\\{`));
    if (!decl || decl.index === undefined) continue;
    const fb = functionBody(code, decl.index + decl[0].length - 1);
    if (!fb) continue;
    const load = fb.body.match(/\bthis\.load\.(image|spritesheet|atlas|audio|bitmapFont)\b/);
    if (load && !/this\.load\.start\(\)/.test(fb.body)) {
      issues.push({
        type: "static",
        severity: "warning",
        file: relFile,
        line: lineAt(code, decl.index + fb.from - decl.index) ,
        message: `this.load.${load[1]} called inside ${name}() — the loader only runs automatically in preload(); move asset loading to preload() (or generate textures procedurally in create())`,
      });
    }
  }

  // 4. Creating game objects in preload(): display objects belong in create().
  {
    const decl = code.match(/(?:^|[\s;])preload\s*\([^)]*\)\s*\{/);
    if (decl && decl.index !== undefined) {
      const fb = functionBody(code, decl.index + decl[0].length - 1);
      const bad = fb?.body.match(/\bthis\.(add|physics\.add|make)\.(\w+)\s*\(/);
      if (fb && bad && !/^textures?$/.test(bad[2])) {
        issues.push({
          type: "static",
          severity: "warning",
          file: relFile,
          line: lineAt(code, decl.index),
          message: `preload() creates game objects (this.${bad[1]}.${bad[2]}) — preload is ONLY for this.load.* and texture generation; create display objects in create()`,
          evidence: fb.body.trim().split("\n").slice(0, 4).join("\n").slice(0, 300),
        });
      }
    }
  }

  return issues;
}
