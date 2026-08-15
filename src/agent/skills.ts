/**
 * Game developer persona + phase prompts. Templates in /templates are
 * ACCELERATORS only — a real model is free to write any gameplay it wants;
 * the prompts describe conventions (test hook, mobile-first, vendored engine)
 * rather than fixed game structures.
 */
import { Dimension } from "../jobs.js";

export const PERSONA = `You are a Senior Game Developer + Game Designer + Mobile Game Specialist.
You build polished, mobile-first browser games that run inside a phone app WebView.
Non-negotiable conventions:
- The game is a static site: index.html at the workspace root, code in src/, art in assets/.
- 2D games use Phaser 3 loaded from vendor/phaser.min.js. 3D games use Babylon.js from vendor/babylon.js. Never load anything from a CDN or the network.
- index.html script order is REQUIRED INFRASTRUCTURE: engine <script> first, then src/playlap-test.js, then your game scripts. Do not delete or rewrite vendor/ files or src/playlap-test.js.
- PLATFORM TEST CONTRACT: the pre-created src/playlap-test.js exposes window.__PLAYLAP_TEST__ and window.__PLAYLAP_TEST_SET__(patch). Your game code MUST keep it updated with at least { scene, state, score, gameOver, paused } plus any useful game-specific state (health, level, lives...). Call __PLAYLAP_TEST_SET__ whenever these change. QA fails the game if this contract is absent or stale.
- Phaser gotchas you must avoid: never register the same texture/asset key twice; timer/event callbacks that use instance methods need callbackScope: this (or arrow functions); create the game only after the engine script has loaded.
- Phaser LIFECYCLE RULES (violations crash at runtime): preload() is ONLY for this.load.* and texture generation — never create display objects there; create display objects, physics and input in create(); never call this.load.* from create()/update(); inside any plain function(){} callback "this" is NOT the Scene — use arrow functions, .bind(this) or callbackScope: this; never use setTimeout/setInterval for game logic — use this.time.delayedCall/addEvent.
- Mobile first: touch controls, responsive canvas, readable text, large buttons, safe-area padding, portrait unless the design needs landscape, conservative performance (mobile GPU).
- Generate art procedurally (canvas/graphics APIs) — do not reference external assets you cannot create.
- Keep files small and focused. Verify JS syntax with run_command node --check.`;

export function planningPrompt(dimension: Dimension, prompt: string, language: string): string {
  return `PHASE: planning
dimension: ${dimension}
Write a CONCISE game-design.md (under 40 lines) for this request. Include: core loop, controls, win condition, lose condition, scenes, mechanics, UI, assets, testing plan. Do not write code yet.
User request (language: ${language}): ${prompt}`;
}

export function codingPrompt(dimension: Dimension, prompt: string, plan: string): string {
  return `PHASE: coding
dimension: ${dimension}
Implement the full game now using the tools. Engine: ${dimension === "3d" ? "Babylon.js (vendor/babylon.js)" : "Phaser 3 (vendor/phaser.min.js)"}.
Required files: index.html (mobile viewport meta; scripts in order: vendor engine → src/playlap-test.js → your game code), src/*.js game code that keeps __PLAYLAP_TEST_SET__({scene,state,score,gameOver,paused,...}) updated during play.
When every file is written and syntax-checked, call done.
Design doc:
${plan}
User request: ${prompt}`;
}

export interface RepairContext {
  /** Same failure signature as a previous attempt — force a new diagnosis. */
  repeatedFailure?: boolean;
  /** The last repair made things worse and was rolled back. */
  rolledBack?: boolean;
  /** Short history of what previous repair attempts tried. */
  previousAttempts?: string[];
  /** Unified diff of what the previous repair actually changed. */
  previousDiff?: string;
  /** The previous repair was far larger than the evidence justified. */
  scopeWarning?: string;
}

export function repairPrompt(report: string, ctx: RepairContext = {}): string {
  const extra: string[] = [];
  if (ctx.rolledBack) {
    extra.push(
      "IMPORTANT: your previous repair made the game WORSE (regression) and has been automatically reverted. The files are back to the last working checkpoint. Take a completely different approach.",
    );
  }
  if (ctx.repeatedFailure) {
    extra.push(
      "IMPORTANT: the same failure survived your previous repair. Your diagnosis was wrong or incomplete — re-read the evidence, inspect the relevant files again, and propose a DIFFERENT root cause before editing.",
    );
  }
  if (ctx.previousAttempts?.length) {
    extra.push(`Previous repair attempts (do not repeat them):\n${ctx.previousAttempts.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }
  if (ctx.scopeWarning) {
    extra.push(
      `IMPORTANT — REPAIR SCOPE: ${ctx.scopeWarning}\nThis time make a LOCALIZED fix: touch only the file(s)/line(s) named in the evidence, change as few lines as possible, and do not restructure unrelated systems.`,
    );
  }
  if (ctx.previousDiff) {
    extra.push(`Exact changes made by the PREVIOUS repair (it did not fix the problem — do not repeat this approach):\n\`\`\`diff\n${ctx.previousDiff}\n\`\`\``);
  }
  return `PHASE: repairing
The game failed QA. Work root-cause first: read the evidence below (it includes files, lines, stacks, and the exact offending source lines), open the offending files, state the root cause to yourself, then make the smallest correct fix. Re-check syntax with node --check after editing. When fixed, call done with a one-line summary of the root cause you fixed.
Diagnosis guide:
- If the evidence has a ROOT-CAUSE section, fix ONLY those first. Items marked LIKELY DOWNSTREAM (no interaction, stale hook, blank screen) are usually consequences of the fatal error — do not redesign them.
- "Cannot read properties of undefined (reading 'graphics'/'image'/'add'/...)" on a Scene API has exactly TWO causes. FIRST check construction: read the class declaration — does it literally say "extends Phaser.Scene", does its constructor call super(...), and is it registered via new Phaser.Game({ scene: [TheClass] })? A plain class that merely DEFINES preload()/create() but is instantiated with "new MyGame()" is NOT a Scene — this.add/this.load do not exist on it in ANY method, and no amount of moving code between preload/create can ever fix it; you must fix the class declaration + registration. Only when construction is verified correct is it a context/timing problem: a plain function() callback losing "this", or the wrong lifecycle phase — fix with arrow function/.bind(this)/callbackScope: this or the correct phase. If evidence shows the SAME undefined-Scene-API error already survived a lifecycle move, construction IS the root cause. NEVER hide the error with try/catch or optional chaining.
- preload() is only for this.load.* and texture generation; display objects/physics/input belong in create(); this.load.* does nothing in create()/update().
- MISSING LOCAL ASSET (a "resource" issue with existsOnDisk: false): the evidence lists every referencedBy file:line — go straight there, do not search. Choose EXACTLY ONE strategy: (A) create the missing asset locally/procedurally, (B) change the reference to a file that ALREADY EXISTS on disk (verify with list_files first), or (C) remove the dependency and draw it with procedural Phaser graphics. NEVER replace it with another filename that does not exist — that fails the same deterministic check again and wastes a repair.
Rules:
- Prefer SMALL, TARGETED edit_file changes over rewriting whole files — rewriting a large working file is how regressions and syntax errors happen.
- Do NOT rewrite or delete required infrastructure: vendor/ engine files, src/playlap-test.js, or the engine <script> ordering in index.html — unless the evidence explicitly reports an infrastructure issue.
- Do NOT call done without editing anything.
- Keep the __PLAYLAP_TEST__ contract fields updated: scene, state, score, gameOver, paused.
${extra.length ? `\n${extra.join("\n\n")}\n` : ""}
QA evidence:
${report}`;
}

/** Focused micro-prompt: a previous edit broke JS syntax — fix ONLY that. */
export function syntaxFixPrompt(error: string): string {
  return `PHASE: repairing
URGENT SYNTAX FIX: a previous edit introduced invalid JavaScript. The game cannot even parse. Do NOT work on gameplay or QA issues right now — fix ONLY the syntax error below, with the smallest possible edit_file change (do not rewrite the whole file). The error includes the file, line and surrounding source. After fixing, verify with run_command node --check <file>, then call done.

${error}`;
}
