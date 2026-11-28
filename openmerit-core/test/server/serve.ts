// The app as the tests run it: a local Rivet engine, test sign-in, fake billing, and a catalogue
// refresh that reports the version in TEST_CATALOGUE_VERSION, with `-<n>` from its second refresh on, and from refresh
// TEST_CATALOGUE_NEW_MODEL on adds test/new-cheap, as capable as anything and cheaper, which a watch re-runs for (TEST_CATALOGUE=broken: a catalogue with no models, on which a
// job's start fails after the account recorded the job), and a broken agent eval with TEST_AGENT_EVAL=broken. The tests start it as a child process
// so they can SIGKILL it. TEST_STRIPE_API_BASE swaps the fake billing for the real Stripe client
// pointed at a local fake Stripe. It prints `ready <url>` once it answers.
import { startApp } from "../../src/server/app.ts";
import { LocalAuth, TestAuth } from "../../src/server/auth.ts";
import { FakeBilling, StripeBilling } from "../../src/server/billing.ts";
import { loadConfig } from "../../src/server/config.ts";
import { bundledCatalogue } from "../../src/server/services.ts";

const env = process.env;
let refreshes = 0;
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
    refreshCatalogue: async () => {
      const base = bundledCatalogue();
      if (env.TEST_CATALOGUE === "broken") return { ...base, version: "broken", models: null as unknown as typeof base.models };
      refreshes += 1;
      const from = Number(env.TEST_CATALOGUE_NEW_MODEL ?? 0), like = base.models.find(model => model.id === "openai/gpt-5.4")!;
      const added = from && refreshes >= from ? [{ ...like, id: "test/new-cheap", name: "New cheap", aliases: [], eci: 200, inputPerM: 0.001, outputPerM: 0.001 }] : [];
      const version = env.TEST_CATALOGUE_VERSION ?? base.version;
      return { ...base, version: refreshes > 1 ? `${version}-${refreshes}` : version, models: [...base.models, ...added] };
    },
    // TEST_AGENT_EVAL=broken: an agent eval that fails on every call, so its step fails for good.
    ...(env.TEST_AGENT_EVAL === "broken" ? { agentEval: () => async () => { throw new Error("the agent's eval harness is unreachable"); } } : {}),
  },
});
process.stdout.write(`ready ${url}\n`);
