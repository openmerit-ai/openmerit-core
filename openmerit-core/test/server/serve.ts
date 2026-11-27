// The app as the tests run it: a local Rivet engine, test sign-in, fake billing, and a catalogue
// refresh that reports the version in TEST_CATALOGUE_VERSION (TEST_CATALOGUE=broken: a catalogue with no models, on which a
// job's start fails after the account recorded the job), and a broken agent eval with TEST_AGENT_EVAL=broken. The tests start it as a child process
// so they can SIGKILL it. TEST_STRIPE_API_BASE swaps the fake billing for the real Stripe client
// pointed at a local fake Stripe. It prints `ready <url>` once it answers.
import { startApp } from "../../src/server/app.ts";
import { LocalAuth, TestAuth } from "../../src/server/auth.ts";
import { FakeBilling, StripeBilling } from "../../src/server/billing.ts";
import { loadConfig } from "../../src/server/config.ts";
import { bundledCatalogue } from "../../src/server/services.ts";

const env = process.env;
process.env.RIVETKIT_STORAGE_PATH = env.TEST_STORAGE!;
process.env.RIVET__AUTH__ADMIN_TOKEN = "test-token";
const { url } = await startApp({
  config: loadConfig(env),
  // Self-hosted, the real sign-in: the server's token (LOCAL_TOKEN in helpers.ts) and the web app's sign-in link.
  auth: env.OPENMERIT_MODE === "self-hosted" ? new LocalAuth(env.TEST_LOCAL_TOKEN!, "the test token") : new TestAuth(),
  billing: env.TEST_STRIPE_API_BASE
    ? new StripeBilling({ secretKey: "sk_test", webhookSecret: "whsec_test", priceId: "price_test", meterEvent: "openmerit_evaluation", apiBase: env.TEST_STRIPE_API_BASE })
    : new FakeBilling("whsec_test"),
  local: { port: Number(env.TEST_ENGINE_PORT), token: "test-token" },
  services: {
    refreshCatalogue: async () => env.TEST_CATALOGUE === "broken"
      ? { ...bundledCatalogue(), version: "broken", models: null as unknown as ReturnType<typeof bundledCatalogue>["models"] }
      : { ...bundledCatalogue(), version: env.TEST_CATALOGUE_VERSION ?? bundledCatalogue().version },
    // TEST_AGENT_EVAL=broken: an agent eval that fails on every call, so its step fails for good.
    ...(env.TEST_AGENT_EVAL === "broken" ? { agentEval: () => async () => { throw new Error("the agent's eval harness is unreachable"); } } : {}),
  },
});
process.stdout.write(`ready ${url}\n`);
