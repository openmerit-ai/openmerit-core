import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRoute } from "../src/routes.js";
import { runStandaloneTrial } from "../src/standalone.js";
import { paths, writeJson } from "../src/store.js";

const previous = {
  home: process.env.OPENMERIT_HOME,
  bin: process.env.OPENMERIT_PI_BIN,
  openrouter: process.env.OPENROUTER_API_KEY,
};
let dir: string | null = null;

afterEach(() => {
  for (const [name, value] of Object.entries({
    OPENMERIT_HOME: previous.home,
    OPENMERIT_PI_BIN: previous.bin,
    OPENROUTER_API_KEY: previous.openrouter,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("provider-neutral standalone trials", () => {
  it("executes candidates, judge, and strategist through exact Pi routes without OpenRouter", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-standalone-"));
    process.env.OPENMERIT_HOME = dir;
    delete process.env.OPENROUTER_API_KEY;
    const bin = join(dir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1];
const model = args[args.indexOf('--model') + 1];
if (provider === 'openrouter') process.exit(20);
const prompt = args.at(-1);
let text;
if (prompt.includes('finding the best configured model route')) text = '{"next_model":"local:model-b","why":"better local route"}';
else if (prompt.includes('You are grading')) text = prompt.includes('ANSWER: answer a')
  ? '{"score":0.4,"why":"weak"}' : '{"score":0.9,"why":"strong"}';
else text = provider === 'native' && model === 'model-a' ? 'answer a' : 'answer b';
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
  content: [{ type: 'text', text }], usage: { input: 10, output: 5, totalTokens: 15,
  cost: { total: 0.001 } }, stopReason: 'stop' } }));
`);
    chmodSync(bin, 0o755);
    process.env.OPENMERIT_PI_BIN = bin;

    const active = modelRoute("native", "model-a", { input: ["text"],
      cost: { input: 1, output: 2 }, contextWindow: 8192, maxTokens: 4096 });
    const candidate = modelRoute("local", "model-b", { input: ["text"],
      cost: { input: 0.2, output: 0.4 }, contextWindow: 8192, maxTokens: 4096 });
    writeJson(paths.harnessState(), { schemaVersion: 1, currentRoute: active, routes: [active, candidate] });
    const taskFile = join(dir, "task.json");
    writeFileSync(taskFile, JSON.stringify({
      task: "solve the standalone task", eval: "correct and concise",
      initial_model: active.meritId, initial_route: "native:model-a", cwd: dir,
    }));

    const result = await runStandaloneTrial(taskFile, 2);

    expect(result.points).toHaveLength(2);
    expect(result.points.map((point) => point.route?.provider)).toEqual(["native", "local"]);
    expect(result.recommendation?.recommended.route).toMatchObject({ provider: "local", modelId: "model-b" });
    expect(result.recommendation?.policy.autoApply).toBe(false);
    expect(readFileSync(paths.recommendations(), "utf8")).toContain('"provider":"local"');
  }, 15_000);
});
