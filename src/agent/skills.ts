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
  return `PHASE: repairing
The game failed QA. Work root-cause first: read the evidence below (it includes files, lines, stacks and state), open the offending files, state the root cause to yourself, then make the smallest correct fix. Re-check syntax with node --check after editing. When fixed, call done with a one-line summary of the root cause you fixed.
Rules:
- Do NOT rewrite or delete required infrastructure: vendor/ engine files, src/playlap-test.js, or the engine <script> ordering in index.html — unless the evidence explicitly reports an infrastructure issue.
- Do NOT call done without editing anything.
- Keep the __PLAYLAP_TEST__ contract fields updated: scene, state, score, gameOver, paused.
${extra.length ? `\n${extra.join("\n\n")}\n` : ""}
QA evidence:
${report}`;
}
