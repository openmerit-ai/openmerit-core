import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAutomationPlan, OpenMeritCoordinator, ProjectStore } from "../../core/src/index.ts";
import type { HarnessDescriptor, OpenMeritProjectState } from "../../protocol/src/index.ts";

const wakeupDescriptor: HarnessDescriptor = {
  id: "pi-launchagent", name: "Pi LaunchAgent", version: "0.87", protocolVersions: ["0.1"],
  capabilities: [], executionModes: ["non_interactive"],
  structuredOutput: { schemaDialect: "https://json-schema.org/draft/2020-12/schema", presentation: "adapter_validation", enforcement: "adapter" },
  automation: {
    supportedSignals: ["product_task_completed", "metric_window_available", "scheduled_tick", "model_catalog_changed", "verification_window_completed"],
    persistentScheduling: true, backgroundExecution: true, wakeupProvisioning: "infrastructure_change",
  },
};

export function isPiWakeupDue(state: OpenMeritProjectState, now = new Date().toISOString()): boolean {
  const execution = state.cycle.policy?.checkPolicy.execution;
  if (execution?.mode !== "persistent" || !execution.infrastructureChangesAllowed || state.activeIntent || state.automation.paused) return false;
  if (state.automation.pendingIntentKind) return true;
  const at = buildAutomationPlan(state, wakeupDescriptor).nextWakeupAt;
  return at !== undefined && Date.parse(at) <= Date.parse(now);
}

async function run(): Promise<void> {
  const [projectRoot, piPath, extensionPath, provider, modelId] = process.argv.slice(2);
  if (!projectRoot || !piPath || !extensionPath || !provider || !modelId) process.exitCode = 2;
  if (process.exitCode) return;
  const store = new ProjectStore(projectRoot!);
  const state = await store.readState();
  if (!state || !isPiWakeupDue(state)) return;
  const startedAt = new Date().toISOString();
  const coordinator = new OpenMeritCoordinator(store, {
    descriptor: wakeupDescriptor,
    async dispatch() { return { accepted: false, reason: "The wakeup runner does not dispatch harness work directly." }; },
  });
  const check = state.automation.pendingIntentKind === "run_assessment"
    ? await coordinator.assessBaseline(startedAt)
    : state.automation.pendingIntentKind
      ? undefined
      : await coordinator.recordAutomationSignal({
          protocolVersion: "0.1", id: `wakeup-${crypto.randomUUID()}`,
          type: "scheduled_tick", occurredAt: startedAt, targetId: state.cycle.targetId!,
        });
  if (check && check.decision.action !== "issue_intent") {
    await writeFile(join(store.directory, "scheduler-status.json"), JSON.stringify({
      schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), exitCode: 0,
      decision: check.decision.reason,
    }, null, 2) + "\n", { mode: 0o600 });
    return;
  }
  const configuredTimeout = Number(process.env.OPENMERIT_WAKEUP_TIMEOUT_MS);
  const runLimitMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000
    ? Math.min(configuredTimeout, 15 * 60_000)
    : 15 * 60_000;
  const deadline = Date.now() + runLimitMs;
  const invokePi = async (prompt: string): Promise<number> => {
    const child = spawn(piPath!, [
      "--no-extensions", "--extension", extensionPath!, "--provider", provider!, "--model", modelId!,
      ...(process.env.OPENMERIT_WAKEUP_DEBUG === "1" ? ["--mode", "json"] : []),
      "--no-session", "--print", prompt,
    ], { cwd: projectRoot!, stdio: process.env.OPENMERIT_WAKEUP_DEBUG === "1" ? "inherit" : "ignore", env: process.env });
    return new Promise<number>((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, Math.max(1, deadline - Date.now()));
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); resolve(timedOut ? 124 : code ?? 1); });
    });
  };
  let exitCode = await invokePi(
    "Run the due OpenMerit scheduled check for this configured project. " +
    "On startup, OpenMerit may create an active intent in .openmerit/state.json. Read that intent and .openmerit/config.json, " +
    "perform only its authorized work, and call openmerit_complete_intent exactly once with verified evidence. " +
    "For baseline assessment, if no application metric windows exist, report insufficiency promptly; do not wait for new data or invent samples. " +
    "If evidence is unavailable, report failure honestly. Never change Pi's model or an unauthorized application route.",
  );
  const issued = await store.readState();
  if (exitCode === 0 && issued?.activeIntent && !state.activeIntent && Date.now() < deadline) {
    const intent = issued.activeIntent;
    exitCode = await invokePi(
      `Complete the already active OpenMerit ${intent.kind} intent ${intent.id}. ` +
      "Read .openmerit/config.json and the project evidence. Follow the requested outcome and constraints below. " +
      "Use the registered openmerit_complete_intent tool exactly once, with verified evidence; if evidence is unavailable, report failure honestly. " +
      "Never change Pi's model or the application model unless this intent explicitly authorizes that target-bound change.\n\n" +
      JSON.stringify(intent),
    );
    if ((await store.readState())?.activeIntent?.id === intent.id) exitCode = 1;
  }
  const finalState = await store.readState();
  if (finalState?.activeIntent && exitCode === 0) exitCode = 1;
  if (finalState?.automation.pendingIntentKind && exitCode === 0) exitCode = 1;
  await writeFile(join(store.directory, "scheduler-status.json"), JSON.stringify({
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), exitCode,
    ...(finalState?.activeIntent ? { activeIntentId: finalState.activeIntent.id } : {}),
  }, null, 2) + "\n", { mode: 0o600 });
  process.exitCode = exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((error: unknown) => {
    process.stderr.write(`OpenMerit Pi wakeup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
