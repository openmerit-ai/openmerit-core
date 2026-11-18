// The app as the tests run it: a local Rivet engine, test sign-in, fake billing, and a catalogue
// refresh that reports the version in TEST_CATALOGUE_VERSION. The tests start it as a child process
// so they can SIGKILL it. It prints `ready <url>` once it answers.
import { startApp } from "../src/app.ts";
import { TestAuth } from "../src/auth.ts";
import { FakeBilling } from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { bundledCatalogue } from "../src/services.ts";

const env = process.env;
process.env.RIVETKIT_STORAGE_PATH = env.TEST_STORAGE!;
process.env.RIVET__AUTH__ADMIN_TOKEN = "test-token";
const { url } = await startApp({
  config: loadConfig(env),
  auth: new TestAuth(),
  billing: new FakeBilling("whsec_test"),
  local: { port: Number(env.TEST_ENGINE_PORT), token: "test-token" },
  services: { refreshCatalogue: async () => ({ ...bundledCatalogue(), version: env.TEST_CATALOGUE_VERSION ?? bundledCatalogue().version }) },
});
process.stdout.write(`ready ${url}\n`);
