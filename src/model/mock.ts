/**
 * Mock provider — deterministic, offline, no GPU. Used to exercise the FULL
 * pipeline (plan → code → build → run → playtest → quality gate) inside
 * environments without a model runtime (e.g. Replit acceptance testing).
 *
 * It behaves like a scripted "developer": in the planning phase it returns a
 * concise game-design.md; in the coding phase it emits write_file tool calls
 * from a bundled reference implementation (2D Phaser fishing-style game or a
 * 3D Babylon collector) then calls done; in repair phases it re-emits the
 * affected file.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { ChatMessage, ChatResponse, ModelProvider, ToolCall, ToolDef } from "./provider.js";

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `mock_${++callSeq}`, name, arguments: args };
}

function templateDir(dimension: string): string {
  return path.join(config.serverRoot, "templates", dimension === "3d" ? "orb-3d" : "fishing-2d");
}

function listTemplateFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listTemplateFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly modelName = "mock-game-developer";

  async status(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "mock provider always ready" };
  }

  async chat(messages: ChatMessage[], _tools: ToolDef[]): Promise<ChatResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const dimension = /dimension:\s*3d/i.test(system) || /\b3d\b/i.test(lastUser) ? "3d" : "2d";

    if (/PHASE:\s*planning/i.test(system)) {
      return { content: planFor(dimension, lastUser), toolCalls: [] };
    }

    if (/PHASE:\s*(coding|repairing|polishing)/i.test(system)) {
      // Figure out which template files were already written in this conversation.
      const written = new Set<string>();
      for (const m of messages) {
        for (const c of m.toolCalls ?? []) {
          if (c.name === "write_file" && typeof c.arguments.path === "string") written.add(c.arguments.path);
        }
      }
      const dir = templateDir(dimension);
      const files = listTemplateFiles(dir);
      const batch: ToolCall[] = [];
      for (const rel of files) {
        if (written.has(rel)) continue;
        batch.push(call("write_file", { path: rel, content: fs.readFileSync(path.join(dir, rel), "utf8") }));
        if (batch.length >= 3) break; // emit a few files per turn like a real agent
      }
      if (batch.length > 0) {
        return { content: `Writing ${batch.length} file(s).`, toolCalls: batch };
      }
      return {
        content: "All game files are in place and verified.",
        toolCalls: [call("done", { summary: "Implementation complete." })],
      };
    }

    return { content: "OK", toolCalls: [call("done", { summary: "Nothing to do." })] };
  }
}

function planFor(dimension: string, prompt: string): string {
  const short = prompt.slice(0, 140).replace(/\s+/g, " ");
  if (dimension === "3d") {
    return [
      `# Game Design — 3D Orb Collector`,
      `Request: ${short}`,
      `- Core loop: move the player sphere, collect glowing orbs before the timer ends.`,
      `- Controls: drag / arrow keys; on-screen touch joystick zones (mobile-first).`,
      `- Win: collect all orbs. Lose: timer reaches zero.`,
      `- Scenes: single Babylon scene with HUD overlay.`,
      `- Mechanics: movement, pickup collision, score, timer.`,
      `- UI: score, timer, win/lose banner, restart button (large touch targets).`,
      `- Assets: procedural materials only (no external downloads).`,
      `- Testing: window.__PLAYLAP_TEST__ exposes scene, score, state; QA taps to move and verifies score changes.`,
    ].join("\n");
  }
  return [
    `# Game Design — 2D Fishing Game`,
    `Request: ${short}`,
    `- Core loop: cast the line, wait for a bite, tap to catch, earn points before time runs out.`,
    `- Controls: single tap / click (thumb-friendly, portrait).`,
    `- Win: reach target score. Lose: timer ends below target.`,
    `- Scenes: Boot → Play (Phaser 3).`,
    `- Mechanics: cast, bite timing window, catch scoring, fish variety, restart.`,
    `- UI: score, timer, state hints, big restart button, safe-area padding.`,
    `- Assets: generated textures (graphics API) — no external downloads.`,
    `- Testing: window.__PLAYLAP_TEST__ exposes scene, state, score, fishCaught; QA simulates taps through a full cast→catch cycle.`,
  ].join("\n");
}
