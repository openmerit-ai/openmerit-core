// The production entry point, which the Docker image runs on a Rivet Cloud actor node. The cluster
// sets RIVET_ENDPOINT, RIVET_TOKEN and RIVET_POOL; the app's own settings and secrets are in
// cloud/README.md.
import { createServer } from "node:http";
import { startApp } from "./app.ts";
import { ClerkAuth, LocalAuth, localToken } from "./auth.ts";
import { StripeBilling } from "./billing.ts";
import { loadConfig } from "./config.ts";
import { fetchCatalogue } from "../../openmerit-core/src/catalogue/build.ts";
import { loadCatalogue } from "../../openmerit-core/src/catalogue/catalogue.ts";

const config = loadConfig();

/** A fresh catalogue from OpenRouter and Epoch. A partial upstream answer must not shrink the pool every task searches, so a catalogue under half the bundled one's size is refused and the current one kept. */
async function refreshFromUpstream() {
  const next = await fetchCatalogue(), bundled = loadCatalogue().models.length;
  if (next.models.length < bundled / 2) throw new Error(`The refreshed catalogue has ${next.models.length} models, under half of the bundled ${bundled}; kept the current one.`);
  return next;
}
const selfHosted = config.mode === "self-hosted";
// Self-hosted: one local token signs in, and a local engine keeps its state in the data directory.
const local = selfHosted ? localToken(config.dataDir) : null;
if (local) {
  process.env.RIVETKIT_STORAGE_PATH ??= config.dataDir;
  // The local engine's admin token is the server's token, so nothing without it reaches the engine either.
  process.env.RIVET__AUTH__ADMIN_TOKEN = local.token;
}
const { registry } = await startApp({
  config,
  auth: local ? new LocalAuth(local.token, local.file) : config.clerk ? new ClerkAuth(config.clerk) : null,
  billing: config.stripe ? new StripeBilling(config.stripe) : null,
  ...(local ? { local: { port: Number(process.env.OPENMERIT_ENGINE_PORT ?? config.port + 1), token: local.token } } : {}),
  // Hosted, the catalogue refreshes daily from OpenRouter's and Epoch's public data; a self-hosted server keeps the bundled one.
  ...(selfHosted ? {} : { services: { refreshCatalogue: refreshFromUpstream } }),
});
const missing = [!selfHosted && !config.clerk && "Clerk", !selfHosted && !config.stripe && "Stripe", !config.keyEncryptionKey && "the key-encryption key", !config.openrouter.apiKey && "OpenRouter"].filter(Boolean);
console.log(`OpenMerit ${config.mode} on ${config.host ?? ""}:${config.port} for ${config.publicUrl}${local ? `; token in ${local.file}` : ""}${missing.length ? `; not configured: ${missing.join(", ")}` : ""}`);

// Metrics, collected with the logs. Kept on localhost, as Rivet's actor-node guide does.
createServer(async (_req, res) => {
  const metrics = await registry.routes.prometheusMetrics();
  res.writeHead(metrics.status, Object.fromEntries(metrics.headers));
  res.end(await metrics.text());
}).listen(Number(process.env.RIVETKIT_METRICS_PORT ?? 9464), "127.0.0.1");
