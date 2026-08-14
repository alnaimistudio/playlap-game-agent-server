/**
 * Real-browser QA: serve the build, open it in headless Chromium via
 * Playwright, capture console + page errors, take screenshots, poke the game
 * through taps/keys, and read window.__PLAYLAP_TEST__.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium, Browser } from "playwright-core";
import { config } from "../config.js";
import { log } from "../logger.js";
import { Workspace } from "./workspace.js";

export interface PlaytestReport {
  ok: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  testHook: Record<string, unknown> | null;
  canvasPresent: boolean;
  canvasPaintedRatio: number; // 0..1 non-background pixel ratio of screenshot
  interactionEffect: boolean; // game state changed after simulated input
  screenshots: string[];
  notes: string[];
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
    // CHROMIUM_NO_SANDBOX=1 is a dev-environment escape hatch for hosts where
    // the sandbox cannot start (e.g. Replit/NixOS); never set it in production.
    args: [
      ...(process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
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

export async function playtest(ws: Workspace, buildDir: string, jobId: string): Promise<PlaytestReport> {
  const report: PlaytestReport = {
    ok: false,
    consoleErrors: [],
    pageErrors: [],
    testHook: null,
    canvasPresent: false,
    canvasPaintedRatio: 0,
    interactionEffect: false,
    screenshots: [],
    notes: [],
  };
  const shotsDir = path.join(ws.root, "artifacts", "screenshots");
  fs.mkdirSync(shotsDir, { recursive: true });
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
      report.notes.push(`blocked network request: ${route.request().url().slice(0, 120)}`);
      return route.abort("accessdenied");
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") report.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => report.pageErrors.push(String(e.message).slice(0, 300)));

    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(2500); // let the engine boot

    const shot = async (name: string): Promise<Buffer> => {
      const file = path.join(shotsDir, `${name}.png`);
      const buf = await page.screenshot({ path: file });
      report.screenshots.push(path.relative(ws.root, file));
      return buf;
    };

    const initial = await shot("01-initial");
    report.canvasPresent = (await page.locator("canvas").count()) > 0;
    report.canvasPaintedRatio = paintedRatio(initial);

    const readHook = () =>
      page
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

    const before = await readHook();
    report.testHook = before;

    // Simulated gameplay: taps across the play area + arrow keys.
    const vp = page.viewportSize()!;
    for (const [fx, fy] of [
      [0.5, 0.6],
      [0.5, 0.5],
      [0.3, 0.7],
      [0.7, 0.7],
      [0.5, 0.6],
    ]) {
      await page.touchscreen.tap(vp.width * fx, vp.height * fy).catch(() => undefined);
      await page.waitForTimeout(700);
    }
    for (const key of ["ArrowRight", "ArrowUp", "Space"]) {
      await page.keyboard.press(key).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    // Let timed gameplay (bite windows etc.) progress, tapping occasionally.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      await page.touchscreen.tap(vp.width * 0.5, vp.height * 0.6).catch(() => undefined);
    }
    await shot("02-gameplay");

    const after = await readHook();
    if (after) report.testHook = after;
    report.interactionEffect = JSON.stringify(before) !== JSON.stringify(after) && after !== null;
    await page.waitForTimeout(500);
    await shot("03-state");

    if (!report.canvasPresent) report.notes.push("No <canvas> element found — engine likely failed to boot.");
    if (!report.testHook) report.notes.push("window.__PLAYLAP_TEST__ hook missing.");
    if (!report.interactionEffect) report.notes.push("Game state did not change after simulated input.");
    if (report.canvasPaintedRatio < 0.05) report.notes.push("Screen appears blank (very low paint density).");

    report.ok =
      report.pageErrors.length === 0 &&
      report.consoleErrors.length === 0 &&
      report.canvasPresent &&
      report.testHook !== null &&
      report.canvasPaintedRatio >= 0.05 &&
      report.interactionEffect;
    await context.close();
  } catch (err) {
    report.pageErrors.push(`QA harness error: ${String((err as Error).message)}`);
    log("error", "playtest crashed", { jobId, error: String(err) });
  } finally {
    await browser?.close().catch(() => undefined);
    close();
  }
  return report;
}
