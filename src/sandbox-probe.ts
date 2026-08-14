/**
 * Chromium sandbox probe used by docker/start.sh.
 * Launches Chromium WITH its sandbox (never --no-sandbox), opens a page and
 * exits 0 on success / 1 on failure. Keeps /health honest and lets startup
 * fail fast (or fall back only when ALLOW_NO_SANDBOX=1 is explicitly set).
 */
import { chromium } from "playwright-core";

async function main(): Promise<void> {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--disable-dev-shm-usage"], // sandbox stays ON
  });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent("<title>sandbox-probe</title>");
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  },
);
