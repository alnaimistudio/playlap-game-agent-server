/**
 * The agent's tool belt — every operation is confined to the job workspace,
 * with an allowlist for commands and packages. Generated code is untrusted:
 * no shell interpolation, no network installs outside the allowlist, no
 * access to env files, .git, or anything outside the workspace root.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { ToolDef } from "../model/provider.js";
import { Workspace, safePath, enforceSizeLimit } from "./workspace.js";
import { config } from "../config.js";

/** Packages a game is allowed to depend on. install maps to a local vendor copy when available. */
export const PACKAGE_ALLOWLIST: Record<string, { vendorFile?: string; vendorFrom?: string }> = {
  phaser: { vendorFile: "vendor/phaser.min.js", vendorFrom: "node_modules/phaser/dist/phaser.min.js" },
  babylonjs: { vendorFile: "vendor/babylon.js", vendorFrom: "node_modules/babylonjs/babylon.js" },
  // Build/test tooling — available inside the image, no per-job install needed.
  vite: {},
  playwright: {},
  "@playwright/test": {},
};

/**
 * Terminal commands the agent may run (binary + strictly validated args, no
 * shell). `node` is ONLY allowed as a syntax checker (`node --check <file>`)
 * — never to execute code, so a malicious model cannot run `node -e ...`
 * with the server's privileges.
 */
type ArgValidator = (args: string[]) => string | null; // returns error or null
const COMMAND_ALLOWLIST: Record<string, ArgValidator> = {
  node: (args) =>
    args.length === 2 && args[0] === "--check" && !args[1].startsWith("-")
      ? null
      : "node may only be used as: node --check <file>",
  ls: (args) => (args.every((a) => /^-[alR1]+$/.test(a) || !a.startsWith("-")) ? null : "unsupported ls flag"),
  cat: (args) => (args.length >= 1 && args.every((a) => !a.startsWith("-")) ? null : "cat takes only file paths"),
};

const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 8_000;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "write_file",
    description: "Create or overwrite a file in the game workspace (relative path).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "edit_file",
    description: "Replace an exact text snippet in a file (first occurrence).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
    },
  },
  {
    name: "list_files",
    description: "List files in the workspace (recursive).",
    parameters: { type: "object", properties: { dir: { type: "string" } } },
  },
  {
    name: "search_files",
    description: "Search workspace files for a plain-text query; returns file:line matches.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "run_command",
    description: "Run an allowlisted command inside the workspace (e.g. node --check src/game.js).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      required: ["command"],
    },
  },
  {
    name: "install_package",
    description: "Install an approved dependency (phaser, babylonjs). Vendored locally — no network.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "done",
    description: "Signal that the current phase's work is complete.",
    parameters: { type: "object", properties: { summary: { type: "string" } } },
  },
];

/**
 * Immediate feedback loop: any write/edit to a .js file is syntax-checked on
 * the spot so the model learns about a broken edit in the SAME tool result,
 * instead of discovering it a whole build/QA cycle later.
 */
function syntaxWarning(file: string): string {
  if (!file.endsWith(".js")) return "";
  try {
    execFileSync("node", ["--check", file], { timeout: 15_000, encoding: "utf8" });
    return "";
  } catch (err) {
    const msg = String((err as any).stderr ?? err).slice(0, 600);
    return `\nWARNING — this edit introduced a JavaScript SYNTAX ERROR. Fix it now before doing anything else:\n${msg}`;
  }
}

function listRec(root: string, dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listRec(root, p, out);
    else out.push(path.relative(root, p));
  }
}

export async function executeTool(
  ws: Workspace,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "write_file": {
      const p = safePath(ws, String(args.path ?? ""));
      const content = String(args.content ?? "");
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) return "ERROR: file too large (512KB limit)";
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      enforceSizeLimit(ws);
      return `Wrote ${Buffer.byteLength(content)} bytes to ${args.path}${syntaxWarning(p)}`;
    }
    case "read_file": {
      const p = safePath(ws, String(args.path ?? ""));
      if (!fs.existsSync(p)) return "ERROR: file not found";
      return fs.readFileSync(p, "utf8").slice(0, MAX_OUTPUT_CHARS);
    }
    case "edit_file": {
      const p = safePath(ws, String(args.path ?? ""));
      if (!fs.existsSync(p)) return "ERROR: file not found";
      const text = fs.readFileSync(p, "utf8");
      const find = String(args.find ?? "");
      if (!find || !text.includes(find)) return "ERROR: snippet not found in file";
      fs.writeFileSync(p, text.replace(find, String(args.replace ?? "")));
      return `Edit applied.${syntaxWarning(p)}`;
    }
    case "list_files": {
      const base = args.dir ? safePath(ws, String(args.dir)) : ws.root;
      if (!fs.existsSync(base)) return "ERROR: directory not found";
      const out: string[] = [];
      listRec(ws.root, base, out);
      return out.slice(0, 300).join("\n") || "(empty)";
    }
    case "search_files": {
      const q = String(args.query ?? "");
      if (!q) return "ERROR: empty query";
      const files: string[] = [];
      listRec(ws.root, ws.root, files);
      const hits: string[] = [];
      for (const rel of files) {
        if (!/\.(js|ts|html|css|json|md)$/.test(rel)) continue;
        const lines = fs.readFileSync(path.join(ws.root, rel), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.includes(q) && hits.length < 60) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
      return hits.join("\n") || "No matches.";
    }
    case "run_command": {
      const cmd = String(args.command ?? "");
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const validator = COMMAND_ALLOWLIST[cmd];
      if (!validator) return `ERROR: command not allowed: ${cmd}`;
      const argError = validator(cmdArgs);
      if (argError) return `ERROR: ${argError}`;
      // Every non-flag argument must resolve inside the workspace (symlink-safe).
      for (const a of cmdArgs) {
        if (a.startsWith("-")) continue;
        try {
          safePath(ws, a);
        } catch {
          return `ERROR: argument escapes workspace: ${a}`;
        }
      }
      return await runConfined(ws, cmd, cmdArgs);
    }
    case "install_package": {
      const name = String(args.name ?? "");
      const spec = PACKAGE_ALLOWLIST[name];
      if (!spec) return `ERROR: package not in allowlist: ${name}. Allowed: ${Object.keys(PACKAGE_ALLOWLIST).join(", ")}`;
      if (spec.vendorFile && spec.vendorFrom) {
        const dst = safePath(ws, spec.vendorFile);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(config.serverRoot, spec.vendorFrom), dst);
        return `Installed ${name} → ${spec.vendorFile} (vendored, offline)`;
      }
      return `${name} is provided by the server tooling — nothing to install.`;
    }
    case "done":
      return "done";
    default:
      return `ERROR: unknown tool ${name}`;
  }
}

function runConfined(ws: Workspace, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: ws.root,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: ws.root, NODE_OPTIONS: "--max-old-space-size=256" },
      },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim().slice(0, MAX_OUTPUT_CHARS);
        if (err && (err as any).killed) resolve("ERROR: command timed out");
        else if (err) resolve(`EXIT ${(err as any).code ?? 1}\n${out}`);
        else resolve(out || "(no output)");
      },
    );
  });
}
