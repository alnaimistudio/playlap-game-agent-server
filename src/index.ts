import { assertConfig, config } from "./config.js";
import { log } from "./logger.js";
import { loadPersistedJobs } from "./jobs.js";
import { setRunner } from "./queue.js";
import { createProvider } from "./model/index.js";
import { runJob } from "./agent/agent.js";
import { buildApp } from "./server.js";
import { probeBrowser } from "./agent/playtest.js";

assertConfig();
loadPersistedJobs();

const provider = createProvider();
setRunner((job, isCancelled) => runJob(provider, job, isCancelled));

// Warm the browser readiness probe so /health reflects a real launch check.
void probeBrowser().then((p) =>
  log(p.ok ? "info" : "error", "browser readiness probe", { ok: p.ok, detail: p.detail }),
);

const app = buildApp(provider);
app.listen(config.port, "0.0.0.0", () => {
  log("info", "Play Lap Game Agent Server listening", {
    port: config.port,
    provider: provider.name,
    model: provider.modelName,
    maxConcurrentJobs: config.maxConcurrentJobs,
  });
});
