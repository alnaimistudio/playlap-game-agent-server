/**
 * Real-browser QA: serve the build, open it in headless Chromium via
 * Playwright, capture rich diagnostics (page errors with stacks, console
 * errors/warnings with source locations, failed resource loads, engine
 * initialization), verify the __PLAYLAP_TEST__ platform contract, discover
 * and exercise interactive elements, and persist structured QA artifacts
 * (artifacts/qa/qa-iteration-N.json + console log + screenshots).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium, Browser, Page } from "playwright-core";
import { config } from "../config.js";
import { log } from "../logger.js";
import { Workspace } from "./workspace.js";
import { QAIssue, TEST_HOOK_REQUIRED_FIELDS } from "./qaTypes.js";
import { findLocalAssetReferences, assetExistsOnDisk } from "./staticChecks.js";

export interface PlaytestReport {
  ok: boolean;
  iteration: number;
  engineLoaded: boolean;
  canvasPresent: boolean;
  canvasPaintedRatio: number; // 0..1 non-background pixel ratio of screenshot
  testHook: Record<string, unknown> | null; // last hook snapshot
  testHookBefore: Record<string, unknown> | null;
  hookContractOk: boolean;
  missingHookFields: string[];
  interactionEffect: boolean; // game state changed after simulated input
  changedHookFields: string[];
  blockedExternal: string[]; // external URLs the game tried to reach
  issues: QAIssue[];
  screenshots: string[];
  notes: string[];
  // kept for backwards compatibility with logs/events
  consoleErrors: string[];
  pageErrors: string[];
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function serveDir(dir: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        if (urlPath === "/favicon.ico") {
          res.writeHead(204).end(); // browsers request this automatically; not a game error
          return;
        }
        let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const file = path.resolve(dir, rel);
        if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir, "index.html")) {
          res.writeHead(403).end();
          return;
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(fs.readFileSync(file));
      } catch {
        res.writeHead(500).end();
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() });
    });
  });
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: config.chromiumPath || undefined,
    // --enable-gpu + ignore-blocklist makes WebGL (software path) work in
    // headless chromium both on Nix and in the Docker image.
    // Chromium's sandbox stays ON by default (the game code is untrusted).
    // CHROMIUM_NO_SANDBOX=1 / ALLOW_NO_SANDBOX=1 is an escape hatch for hosts
    // where the sandbox cannot start (e.g. Replit/NixOS, RunPod).
    args: [
      ...(process.env.CHROMIUM_NO_SANDBOX === "1" || process.env.ALLOW_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
      "--disable-dev-shm-usage",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  });
}

/**
 * Startup browser smoke probe: actually launches Chromium, opens a page and
 * closes it. The cached result feeds /health so the service reports 503
 * until a real browser can run (an executable on disk is not enough).
 */
let browserProbe: { ok: boolean; detail: string } | null = null;
let probing: Promise<{ ok: boolean; detail: string }> | null = null;
export function browserProbeResult(): { ok: boolean; detail: string } | null {
  return browserProbe;
}
export async function probeBrowser(force = false): Promise<{ ok: boolean; detail: string }> {
  if (browserProbe?.ok && !force) return browserProbe;
  if (probing) return probing;
  probing = (async () => {
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const page = await (await browser.newContext()).newPage();
      await page.setContent("<title>probe</title>");
      browserProbe = { ok: true, detail: "chromium launch + page verified" };
    } catch (err) {
      browserProbe = { ok: false, detail: `chromium probe failed: ${String((err as Error).message).slice(0, 200)}` };
    } finally {
      await browser?.close().catch(() => {});
      probing = null;
    }
    return browserProbe;
  })();
  return probing;
}

/** Rough "did anything render" metric from a PNG screenshot buffer: byte entropy proxy. */
function paintedRatio(png: Buffer): number {
  // A blank single-color canvas compresses extremely well; use compressed size
  // per pixel as a cheap density proxy (per playwright-on-nix lesson: judge
  // WebGL by screenshot density, not getImageData).
  const pixels = 402 * 874;
  const bytesPerPixel = png.length / pixels;
  return Math.max(0, Math.min(1, bytesPerPixel / 0.15));
}

/** Diff two hook snapshots; returns the names of top-level fields that changed. */
function diffHook(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}

async function readHook(page: Page): Promise<Record<string, unknown> | null> {
  return page
    .evaluate(() => {
      const h = (window as any).__PLAYLAP_TEST__;
      if (!h) return null;
      try {
        return JSON.parse(JSON.stringify(h, (_k, v) => (typeof v === "function" ? undefined : v)));
      } catch {
        return { unserializable: true };
      }
    })
    .catch(() => null);
}

/**
 * For every issue that has a file+line but no source evidence, read the built
 * source and embed the offending line ±3 with a `>>` marker. Exported for tests.
 */
export function attachSourceEvidence(issues: QAIssue[], buildDir: string): void {
  const base = path.resolve(buildDir);
  for (const issue of issues) {
    if (!issue.file || !issue.line || issue.evidence) continue;
    try {
      // issue.file comes from an UNTRUSTED game's Error.stack — contain it:
      // must resolve inside buildDir and inside a known built content dir.
      const rel = issue.file.replace(/^\/+/, "");
      const p = path.resolve(base, rel);
      if (!p.startsWith(base + path.sep)) continue;
      const inside = path.relative(base, p);
      if (!/^(src|assets|public)[\\/]/.test(inside) && inside !== "index.html") continue;
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, "utf8").split("\n");
      if (issue.line > lines.length) continue;
      const from = Math.max(0, issue.line - 4);
      const to = Math.min(lines.length, issue.line + 3);
      issue.evidence = lines
        .slice(from, to)
        .map((l, i) => `${from + i + 1 === issue.line ? ">>" : "  "} ${from + i + 1}| ${l}`)
        .join("\n");
    } catch {
      /* evidence is best-effort */
    }
  }
}

/**
 * Resolve a browser-observed local resource failure (404 / load failure)
 * deterministically to the workspace file and the exact source lines that
 * reference it, so the repair model never searches blindly. Missing local
 * files are ROOT-CAUSE fatal (file-existence is a fact, not a heuristic).
 */
export function missingResourceIssue(buildDir: string, requestedUrl: string, reason: string): QAIssue {
  const normalized = requestedUrl.replace(/^\/+/, "").split("?")[0].split("#")[0];
  const existsOnDisk = assetExistsOnDisk(buildDir, normalized);
  const refs = findLocalAssetReferences(buildDir).filter((r) => r.assetPath === normalized);
  const detail = {
    requestedUrl,
    normalizedWorkspacePath: normalized,
    existsOnDisk,
    referencedBy: refs.map((r) => ({ file: r.file, line: r.line, sourceLine: r.sourceLine })),
  };
  const strategies =
    " — fix by choosing EXACTLY ONE strategy: (A) create the missing asset locally/procedurally, (B) change the reference to a file that ALREADY EXISTS, or (C) remove the dependency and draw it with procedural graphics. NEVER swap it for another nonexistent filename.";
  return {
    type: "resource",
    severity: existsOnDisk ? "error" : "fatal",
    file: refs[0]?.file,
    line: refs[0]?.line,
    message: `resource ${reason}: ${requestedUrl}${existsOnDisk ? "" : strategies}`,
    evidence: JSON.stringify(detail, null, 2),
  };
}

export async function playtest(ws: Workspace, buildDir: string, jobId: string, iteration = 1): Promise<PlaytestReport> {
  const report: PlaytestReport = {
    ok: false,
    iteration,
    engineLoaded: false,
    canvasPresent: false,
    canvasPaintedRatio: 0,
    testHook: null,
    testHookBefore: null,
    hookContractOk: false,
    missingHookFields: [],
    interactionEffect: false,
    changedHookFields: [],
    blockedExternal: [],
    issues: [],
    screenshots: [],
    notes: [],
    consoleErrors: [],
    pageErrors: [],
  };
  const shotsDir = path.join(ws.root, "artifacts", "screenshots");
  const qaDir = path.join(ws.root, "artifacts", "qa");
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(qaDir, { recursive: true });
  const consoleLog: string[] = [];
  const { url, close } = await serveDir(buildDir);
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 402, height: 874 },
      isMobile: true,
      hasTouch: true,
      userAgent: "PlayLapQA/1.0 Mobile",
    });
    // Egress isolation: the untrusted game may only talk to its own loopback
    // QA server. Everything else (internet, metadata services, internal
    // hosts) is aborted at the browser layer.
    await context.route("**/*", (route) => {
      if (route.request().url().startsWith(url)) return route.continue();
      const blocked = route.request().url().slice(0, 160);
      report.blockedExternal.push(blocked);
      report.issues.push({
        type: "resource",
        severity: "error",
        message: `blocked external network request (games must be offline): ${blocked}`,
      });
      return route.abort("accessdenied");
    });
    // context.route() only covers HTTP(S); close the remaining egress
    // channels (WebSocket, WebRTC, SSE to foreign origins, beacons) inside
    // the page itself. Defense-in-depth: production deployments must ALSO
    // default-deny outbound traffic at the container/network layer.
    // NOTE: passed as a string — function form gets rewritten by the tsx/esbuild
    // transform (injects an `__name` helper that doesn't exist in the page).
    await context.addInitScript(`(function () {
      function deny(name) {
        window[name] = function () {
          throw new Error(name + " is disabled in the Play Lap QA sandbox (games must be offline)");
        };
      }
      deny("WebSocket");
      deny("RTCPeerConnection");
      deny("EventSource");
      try { navigator.sendBeacon = function () { return false; }; } catch (e) {}
    })();`);
    const page = await context.newPage();
    page.on("console", (m) => {
      const loc = m.location();
      const file = loc.url ? loc.url.replace(url, "") : undefined;
      consoleLog.push(`[${m.type()}] ${file ?? ""}:${loc.lineNumber ?? ""} ${m.text()}`);
      if (m.type() === "error") {
        report.consoleErrors.push(m.text().slice(0, 300));
        report.issues.push({
          type: "console",
          severity: "error",
          message: m.text().slice(0, 400),
          file,
          line: loc.lineNumber,
        });
      } else if (m.type() === "warning" && /phaser|babylon|webgl|texture|audio|deprecat/i.test(m.text())) {
        report.issues.push({
          type: "console",
          severity: "warning",
          message: m.text().slice(0, 300),
          file,
          line: loc.lineNumber,
        });
      }
    });
    page.on("pageerror", (e) => {
      report.pageErrors.push(String(e.message).slice(0, 300));
      consoleLog.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`);
      // Map the exception to the FIRST stack frame inside generated game code
      // (skip vendor engine frames) so the repair sees the exact offending
      // source expression, not just the exception text.
      const cleanStack = (e.stack ?? "").replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "/");
      let file: string | undefined;
      let line: number | undefined;
      for (const frame of cleanStack.split("\n")) {
        const m = frame.match(/\/((?:src|assets|public)\/[\w./-]+\.js):(\d+)(?::(\d+))?/) ?? frame.match(/\/([\w.-]+\.js):(\d+)(?::(\d+))?/);
        if (m && !m[1].startsWith("vendor/")) {
          file = m[1];
          line = Number(m[2]);
          break;
        }
      }
      report.issues.push({
        type: "runtime",
        severity: "fatal",
        message: String(e.message).slice(0, 400),
        stack: cleanStack.slice(0, 1200),
        file,
        line,
      });
    });
    page.on("requestfailed", (req) => {
      if (!req.url().startsWith(url)) return; // external blocks already recorded
      report.issues.push(
        missingResourceIssue(buildDir, req.url().replace(url, "/"), `failed to load (${req.failure()?.errorText ?? "unknown"})`),
      );
    });
    page.on("response", (res) => {
      if (res.url().startsWith(url) && res.status() >= 400) {
        report.issues.push(missingResourceIssue(buildDir, res.url().replace(url, "/"), `HTTP ${res.status()}`));
      }
    });

    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(2500); // let the engine boot

    const shot = async (name: string): Promise<Buffer> => {
      const file = path.join(shotsDir, `${name}.png`);
      const buf = await page.screenshot({ path: file });
      report.screenshots.push(path.relative(ws.root, file));
      return buf;
    };

    // Engine + canvas verification (infrastructure vs gameplay classification)
    report.engineLoaded = await page
      .evaluate(
        (g) => typeof (window as any)[g] !== "undefined",
        ws.engine === "babylon" ? "BABYLON" : "Phaser",
      )
      .catch(() => false);
    if (!report.engineLoaded) {
      report.issues.push({
        type: "engine",
        severity: "fatal",
        message: `${ws.engine === "babylon" ? "BABYLON" : "Phaser"} is not defined after page load — engine script missing/failed (infrastructure, not gameplay)`,
      });
    }

    const initial = await shot(`it${iteration}-01-initial`);
    report.canvasPresent = (await page.locator("canvas").count()) > 0;
    report.canvasPaintedRatio = paintedRatio(initial);
    if (!report.canvasPresent) {
      report.issues.push({
        type: report.engineLoaded ? "runtime" : "engine",
        severity: "fatal",
        message: "no <canvas> element exists after load — the game never created its rendering surface",
      });
    }

    // Test-hook contract (before interaction)
    const before = await readHook(page);
    report.testHookBefore = before;
    report.testHook = before;
    if (!before) {
      report.issues.push({
        type: "testHook",
        severity: "fatal",
        message:
          "window.__PLAYLAP_TEST__ is missing — the platform contract requires it (load src/playlap-test.js and call __PLAYLAP_TEST_SET__ from game code)",
      });
    } else {
      report.missingHookFields = TEST_HOOK_REQUIRED_FIELDS.filter((f) => !(f in before));
      // Liveness: the scaffold helper's defaults satisfy field presence, so a
      // hook still exactly at defaults means game code never updated it.
      const defaults = JSON.stringify({ scene: null, state: "boot", score: 0, gameOver: false, paused: false });
      if (JSON.stringify(before) === defaults) {
        report.issues.push({
          type: "testHook",
          severity: "error",
          message:
            "__PLAYLAP_TEST__ is still at scaffold defaults — game code never called __PLAYLAP_TEST_SET__; wire it into scene/state/score changes",
        });
      }
      if (report.missingHookFields.length > 0) {
        report.issues.push({
          type: "testHook",
          severity: "error",
          message: `__PLAYLAP_TEST__ is missing required fields: ${report.missingHookFields.join(", ")}`,
          evidence: JSON.stringify(before).slice(0, 300),
        });
      }
    }

    // ---- interaction testing ----
    // Discover real interactive elements instead of blind taps only.
    const vp = page.viewportSize()!;
    const buttons = page.locator("button, [role='button'], a[onclick], .btn, [data-action]");
    const buttonCount = Math.min(await buttons.count().catch(() => 0), 4);
    for (let i = 0; i < buttonCount; i++) {
      await buttons.nth(i).tap({ timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    // Canvas-focused taps (center + corners of the canvas box when available).
    const canvasBox = await page.locator("canvas").first().boundingBox().catch(() => null);
    const cx = canvasBox ? canvasBox.x + canvasBox.width / 2 : vp.width / 2;
    const cy = canvasBox ? canvasBox.y + canvasBox.height / 2 : vp.height / 2;
    for (const [dx, dy] of [
      [0, 0],
      [0, 0.15],
      [-0.2, 0.2],
      [0.2, 0.2],
      [0, 0],
    ]) {
      await page.touchscreen
        .tap(cx + dx * (canvasBox?.width ?? vp.width), cy + dy * (canvasBox?.height ?? vp.height))
        .catch(() => undefined);
      await page.waitForTimeout(700);
    }
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "Space"]) {
      await page.keyboard.press(key).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    // Let timed gameplay (bite windows etc.) progress, tapping occasionally.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      await page.touchscreen.tap(cx, cy).catch(() => undefined);
    }
    const gameplayShot = await shot(`it${iteration}-02-gameplay`);

    const after = await readHook(page);
    if (after) report.testHook = after;
    report.changedHookFields = diffHook(before, after);
    // Meaningful change: any hook field changed, or the screen visibly changed
    // (paint density delta) when a hook exists but tracks little state.
    const paintDelta = Math.abs(paintedRatio(gameplayShot) - report.canvasPaintedRatio);
    report.interactionEffect = (after !== null && report.changedHookFields.length > 0) || (after !== null && paintDelta > 0.08);
    if (!report.interactionEffect) {
      report.issues.push({
        type: "interaction",
        severity: "error",
        message: "no meaningful state change after simulated input (buttons, canvas taps, keys)",
        evidence: `hook before: ${JSON.stringify(before).slice(0, 250)} | hook after: ${JSON.stringify(after).slice(0, 250)} | paintDelta=${paintDelta.toFixed(3)}`,
      });
    }
    await page.waitForTimeout(500);
    await shot(`it${iteration}-03-state`);

    if (report.canvasPaintedRatio < 0.05) {
      report.issues.push({
        type: "visual",
        severity: "fatal",
        message: `screen appears blank (paint density ${report.canvasPaintedRatio.toFixed(2)}) — nothing is rendering`,
      });
    }

    report.hookContractOk = report.testHook !== null && report.missingHookFields.length === 0;
    report.notes = report.issues.filter((i) => i.severity !== "warning").map((i) => `${i.type}: ${i.message.slice(0, 140)}`);
    report.ok =
      report.issues.filter((i) => i.severity === "fatal").length === 0 &&
      report.consoleErrors.length === 0 &&
      report.pageErrors.length === 0 &&
      report.engineLoaded &&
      report.canvasPresent &&
      report.hookContractOk &&
      report.canvasPaintedRatio >= 0.05 &&
      report.interactionEffect &&
      report.blockedExternal.length === 0;
    await context.close();
  } catch (err) {
    report.pageErrors.push(`QA harness error: ${String((err as Error).message)}`);
    report.issues.push({ type: "runtime", severity: "fatal", message: `QA harness error: ${String((err as Error).message).slice(0, 300)}` });
    log("error", "playtest crashed", { jobId, error: String(err) });
  } finally {
    await browser?.close().catch(() => undefined);
    close();
  }
  // Attach the exact offending source lines to every located issue so the
  // repair model never has to guess from an exception message alone.
  attachSourceEvidence(report.issues, buildDir);
  // Persist QA evidence for later debugging (structured report + console log).
  try {
    fs.writeFileSync(path.join(qaDir, `qa-iteration-${iteration}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(qaDir, `console-iteration-${iteration}.log`), consoleLog.join("\n"));
  } catch (err) {
    log("warn", "failed to persist QA artifacts", { jobId, error: String(err) });
  }
  return report;
}
