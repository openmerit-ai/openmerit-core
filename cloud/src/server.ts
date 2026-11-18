// The production entry point, which the Docker image runs on a Rivet Cloud actor node. The cluster
// sets RIVET_ENDPOINT, RIVET_TOKEN and RIVET_POOL; the app's own settings and secrets are in
// cloud/README.md.
import { createServer } from "node:http";
import { startApp } from "./app.ts";
import { ClerkAuth } from "./auth.ts";
import { StripeBilling } from "./billing.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { registry } = await startApp({
  config,
  auth: config.clerk ? new ClerkAuth(config.clerk) : null,
  billing: config.stripe ? new StripeBilling(config.stripe) : null,
});
const missing = [!config.clerk && "Clerk", !config.stripe && "Stripe", !config.keyEncryptionKey && "the key-encryption key", !config.openrouter.apiKey && "OpenRouter"].filter(Boolean);
console.log(`OpenMerit cloud on :${config.port} for ${config.publicUrl}${missing.length ? `; not configured: ${missing.join(", ")}` : ""}`);

// Metrics, collected with the logs. Kept on localhost, as Rivet's actor-node guide does.
createServer(async (_req, res) => {
  const metrics = await registry.routes.prometheusMetrics();
  res.writeHead(metrics.status, Object.fromEntries(metrics.headers));
  res.end(await metrics.text());
}).listen(Number(process.env.RIVETKIT_METRICS_PORT ?? 9464), "127.0.0.1");
