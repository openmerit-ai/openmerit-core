/** Read-only diagnostics plus a provider-free self-test for first-run support. */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LocalJsonlEventSink, meritEvent } from "./integrations.js";
import { piExecutable, availablePiRoutes } from "./pi-trials.js";
import { DEFAULT_POLICY, loadPolicy, providerAllowed } from "./policy.js";
import { buildRecommendation } from "./recommend.js";
import { applyRouteOverrides, modelRoute, routeCatalog, routeKey, routeLabel } from "./routes.js";
import { validatePiProviderExtensions } from "./pi-config.js";
import {
  appendJsonl, paths, readJsonReport, readJsonlReport, writeJson,
} from "./store.js";
import type { ModelRoute, Recommendation, TrialPoint } from "./types.js";

export type DiagnosticStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  message: string;
  details?: string[];
}

export interface DiagnosticReport {
  schemaVersion: 1;
  ok: boolean;
  checks: DiagnosticCheck[];
  summary: {
    piVersion: string | null;
    routeCount: number;
    pricedRouteCount: number;
    activeRoute: string | null;
  };
}

interface HarnessState {
  currentRoute?: ModelRoute | null;
  routes?: ModelRoute[];
  sessionFile?: string | null;
}

function check(id: string, status: DiagnosticStatus, message: string, details?: string[]): DiagnosticCheck {
  return { id, status, message, ...(details?.length ? { details } : {}) };
}

function packageSources(output: string): string[] {
  return [...new Set(output.split("\n").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim())
    .filter((line) => /openmerit/i.test(line) && /^(npm:|git:|https?:|\.?\.?\/|\/)/.test(line)))];
}

function safePackageSource(source: string): string {
  if (source.startsWith("npm:/")) return `npm:local/${basename(source)}`;
  if (source.startsWith("/")) return `local:${basename(source)}`;
  return source;
}

/** No credentials, prompts, or trace contents are included in this report. */
export function collectDoctorReport(): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];
  const executable = piExecutable();
  const versionResult = spawnSync(executable, ["--version"], { encoding: "utf8" });
  const piVersion = versionResult.status === 0 ? versionResult.stdout.trim() : null;
  checks.push(piVersion
    ? check("pi", "pass", `Pi detected (${piVersion})`)
    : check("pi", "fail", "Pi is not executable"));

  let policy = DEFAULT_POLICY;
  try {
    policy = loadPolicy(paths.policy());
    checks.push(check("policy", "pass", `Policy is valid (v${policy.version}, ${policy.mode})`));
  } catch (error) {
    checks.push(check("policy", "fail", `Policy is invalid: ${(error as Error).message}`));
  }

  const extensions = validatePiProviderExtensions(policy.pi.provider_extensions);
  const safeExtensionErrors = extensions.errors.map((message) => {
    const configured = policy.pi.provider_extensions.find((file) => message.startsWith(`${file}:`));
    return configured ? message.replace(configured, `local:${basename(configured)}`) : message;
  });
  let isolatedExtensionRoutes: ModelRoute[] | null = null;
  let extensionLoadError: string | null = null;
  if (!safeExtensionErrors.length && policy.pi.provider_extensions.length && piVersion) {
    try { isolatedExtensionRoutes = availablePiRoutes(undefined, extensions.valid); }
    catch { extensionLoadError = "Pi could not load the allowlisted provider extensions in isolated mode"; }
  }
  checks.push(safeExtensionErrors.length || extensionLoadError
    ? check("provider-extensions", "fail", "One or more allowlisted Pi provider extensions are unavailable",
        [...safeExtensionErrors, ...(extensionLoadError ? [extensionLoadError] : [])])
    : check("provider-extensions", "pass", policy.pi.provider_extensions.length
      ? `${policy.pi.provider_extensions.length} explicit Pi provider extension${policy.pi.provider_extensions.length === 1 ? " loads" : "s load"} in isolated mode`
      : "No Pi provider extensions are allowlisted"));

  const stateRead = readJsonReport<HarnessState>(paths.harnessState(), {});
  checks.push(!stateRead.valid
    ? check("harness-state", "fail", "harness-state.json is malformed; start Pi to replace it atomically")
    : stateRead.exists
      ? check("harness-state", "pass", "Pi extension state snapshot is readable")
      : check("harness-state", "warn", "No Pi extension state yet; start Pi once with OpenMerit installed"));

  let routes = stateRead.value.routes ?? [];
  const liveSnapshot = routes.length > 0;
  if (!routes.length && piVersion) {
    try { routes = isolatedExtensionRoutes ?? availablePiRoutes(undefined, extensions.valid); }
    catch { /* the check below explains it */ }
  }
  routes = applyRouteOverrides(routes, policy.route_overrides);
  const visibleRouteKeys = new Set(routes.map(routeKey));
  routes = routes.filter((route) => providerAllowed(policy, route.meritId, route.provider));
  const unusedOverrides = Object.keys(policy.route_overrides).filter((key) => !visibleRouteKeys.has(key));
  checks.push(unusedOverrides.length
    ? check("route-overrides", "warn", `${unusedOverrides.length} route metadata override${unusedOverrides.length === 1 ? " does" : "s do"} not match a visible route`, unusedOverrides)
    : check("route-overrides", "pass", `${Object.keys(policy.route_overrides).length} route metadata override${Object.keys(policy.route_overrides).length === 1 ? "" : "s"} applied or ready`));
  const priced = routes.filter((route) => !!route.cost);
  checks.push(routes.length >= 2
    ? check("routes", "pass", `${routes.length} Pi model routes are visible`,
        routes.slice(0, 8).map((route) => `${routeLabel(route)}${route.cost ? "" : " (price unknown)"}`))
    : check("routes", "fail", `Only ${routes.length} policy-eligible Pi route${routes.length === 1 ? " is" : "s are"} visible; at least two are required`));
  checks.push(liveSnapshot
    ? priced.length >= 2
      ? check("pricing", "pass", `${priced.length} eligible routes expose pricing`)
      : check("pricing", "warn", "Fewer than two eligible routes expose pricing; unknown-price routes cannot auto-apply")
    : check("pricing", "warn", "Route prices are unavailable until the extension reports a live Pi snapshot"));

  const session = stateRead.value.sessionFile;
  checks.push(!session
    ? check("session", "warn", "No active saved Pi session is reported yet")
    : existsSync(session)
      ? check("session", "pass", "The reported Pi session file is readable")
      : check("session", "warn", "The reported Pi session file no longer exists"));

  if (piVersion) {
    const listed = spawnSync(executable, ["list"], { encoding: "utf8" });
    const sources = listed.status === 0 ? packageSources(listed.stdout) : [];
    const safeSources = sources.map(safePackageSource);
    checks.push(sources.length > 1
      ? check("installation", "fail", "OpenMerit is installed from multiple Pi package sources", safeSources)
      : sources.length === 1
        ? check("installation", "pass", `One Pi package source is installed`, safeSources)
        : check("installation", "warn", "OpenMerit is not listed as an installed Pi package; use `pi install npm:openmerit`"));
  }

  const jsonlFiles = [
    ["recommendations.jsonl", paths.recommendations()],
    ["trials.jsonl", paths.trials()],
    ["traces/observations.jsonl", paths.observations()],
    ["events.jsonl", paths.events()],
  ] as const;
  const malformed = jsonlFiles.flatMap(([label, file]) => {
    const invalid = readJsonlReport<unknown>(file).invalidLines;
    return invalid.length ? [`${label}: lines ${invalid.join(", ")}`] : [];
  });
  checks.push(malformed.length
    ? check("jsonl", "warn", "Malformed JSONL lines were skipped; valid later records remain readable", malformed)
    : check("jsonl", "pass", "Append-only JSONL state is readable"));

  const ledger = readJsonReport(paths.ledger(), { date: "", trials: 0, usd: 0 });
  checks.push(ledger.valid
    ? check("ledger", "pass", "Trial-spend ledger is readable")
    : check("ledger", "fail", "Trial-spend ledger is malformed; spending remains disabled until repaired"));

  let openRouter = false;
  try {
    const env = process.env.OPENROUTER_API_KEY;
    if (env?.trim()) openRouter = true;
    else if (existsSync(paths.envFile())) openRouter = /^\s*OPENROUTER_API_KEY\s*=\s*\S+/m
      .test(readFileSync(paths.envFile(), "utf8"));
  } catch { /* optional */ }
  checks.push(check("openrouter-enrichment", "pass",
    openRouter ? "Optional OpenRouter enrichment is configured" : "Optional OpenRouter enrichment is not configured"));

  const activeRoute = stateRead.value.currentRoute ? routeLabel(stateRead.value.currentRoute) : null;
  return {
    schemaVersion: 1,
    ok: !checks.some((item) => item.status === "fail"),
    checks,
    summary: { piVersion, routeCount: routes.length, pricedRouteCount: priced.length, activeRoute },
  };
}

export function renderDiagnosticReport(report: DiagnosticReport): string {
  const icon: Record<DiagnosticStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  return report.checks.flatMap((item) => [
    `${icon[item.status].padEnd(4)} ${item.id.padEnd(22)} ${item.message}`,
    ...(item.details ?? []).map((detail) => `       - ${detail}`),
  ]).join("\n");
}

/** Exercise core state, routing, recommendation, and event paths without provider calls. */
export function runOfflineVerify(): DiagnosticReport {
  const previousHome = process.env.OPENMERIT_HOME;
  const root = mkdtempSync(join(tmpdir(), "openmerit-verify-"));
  const checks: DiagnosticCheck[] = [];
  try {
    process.env.OPENMERIT_HOME = root;
    const active = modelRoute("native", "model-a", {
      input: ["text"], cost: { input: 1, output: 2 }, contextWindow: 8192, maxTokens: 4096,
    });
    const candidate = modelRoute("local", "model-b", {
      input: ["text"], cost: { input: 0.2, output: 0.4 }, contextWindow: 8192, maxTokens: 4096,
    });
    writeJson(paths.harnessState(), { schemaVersion: 1, currentRoute: active, routes: [active, candidate] });
    const state = readJsonReport<{ routes?: ModelRoute[] }>(paths.harnessState(), {});
    checks.push(state.valid && state.value.routes?.length === 2
      ? check("atomic-json", "pass", "Atomic JSON state round-trip passed")
      : check("atomic-json", "fail", "Atomic JSON state round-trip failed"));

    const entries = routeCatalog([active, candidate]);
    const point = (route: ModelRoute, score: number): TrialPoint => {
      const entry = entries.get(routeKey(route))!;
      return { schemaVersion: 1, model: route.meritId, route, score, price: entry.price,
        priceKnown: entry.priceKnown, ts: new Date().toISOString(), source: "pi_trial" };
    };
    const recommendation = buildRecommendation("verify-task", "offline verification", active.meritId,
      [point(active, 0.6), point(candidate, 0.9)], DEFAULT_POLICY, "/verify/session.jsonl", active);
    checks.push(recommendation?.recommended.route?.provider === "local" &&
      recommendation.policy.reasons.length > 0
      ? check("provider-neutral", "pass", "Exact provider routes and policy reasons survive recommendation")
      : check("provider-neutral", "fail", "Provider route or policy evidence was lost"));

    const configured = applyRouteOverrides([modelRoute("custom", "model-c")], {
      "custom:model-c": { cost: { input: 0, output: 0 }, context_window: 4096,
        max_tokens: 1024, input: ["text"] },
    })[0];
    const providerExtension = join(root, "custom-provider.ts");
    writeFileSync(providerExtension, "export default function provider() {}\n");
    const extension = validatePiProviderExtensions([providerExtension]);
    checks.push(configured.cost?.input === 0 && configured.contextWindow === 4096 && extension.valid.length === 1
      ? check("custom-routes", "pass", "Exact route metadata and allowlisted provider extensions validate")
      : check("custom-routes", "fail", "Custom route or provider-extension configuration failed"));

    if (recommendation) appendJsonl(paths.recommendations(), recommendation);
    appendJsonl(paths.recommendations(), { schemaVersion: 0, id: "legacy", status: "dismissed" });
    appendFileSync(paths.recommendations(), "{interrupted");
    const history = readJsonlReport<Recommendation>(paths.recommendations());
    checks.push(history.records.length === 2 && history.invalidLines.length === 1
      ? check("jsonl-recovery", "pass", "Valid records survive legacy and interrupted JSONL lines")
      : check("jsonl-recovery", "fail", "JSONL recovery did not preserve valid history"));

    const sink = new LocalJsonlEventSink();
    if (recommendation) sink.emit(meritEvent("recommendation.created", recommendation));
    const events = readJsonlReport(paths.events());
    checks.push(events.records.length === 1
      ? check("events", "pass", "Versioned neutral event sink round-trip passed")
      : check("events", "fail", "Neutral event sink round-trip failed"));

    checks.push(loadPolicy(paths.policy()).mode === "recommend"
      ? check("compatibility", "pass", "Missing 0.1.x policy fields normalize to safe defaults")
      : check("compatibility", "fail", "Policy defaults are unsafe"));
  } catch (error) {
    checks.push(check("verify", "fail", (error as Error).message));
  } finally {
    if (previousHome === undefined) delete process.env.OPENMERIT_HOME;
    else process.env.OPENMERIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    ok: !checks.some((item) => item.status === "fail"),
    checks,
    summary: { piVersion: null, routeCount: 2, pricedRouteCount: 2, activeRoute: "native/model-a via native" },
  };
}
