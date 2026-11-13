// What the CLI and the MCP server share: one repository's local context, and starting a run.
import { loadCatalogue } from "./catalogue/catalogue.ts";
import { createHarness, type Harness } from "./harness/harness.ts";
import { DEFAULT_BUDGET_USD, readGlobalConfig, readRepoConfig } from "./state/config.ts";
import { State } from "./state/db.ts";
import { findRepo } from "./state/paths.ts";
import { packageVersion } from "./update.ts";
import { newRunId, type Context } from "./scout/workflow.ts";

export interface LocalOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export function localContext(options: LocalOptions): Context {
  const env = options.env ?? process.env;
  const repo = findRepo(options.cwd);
  let harness: Promise<Harness> | null = null;
  return {
    state: new State(env), repo, catalogue: loadCatalogue(), env, log: options.log ?? (() => {}),
    ...(options.signal ? { signal: options.signal } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
    harness: () => {
      const settings = readGlobalConfig(env).harness;
      if (!settings) return Promise.reject(new Error("OpenMerit Harness is not set up. Run `openmerit setup`."));
      return (harness ??= createHarness(settings, env).catch(error => { harness = null; throw error; }));
    },
  };
}

/** Settings a run needs before it starts; each entry is something `openmerit setup` configures. */
export function missingSetup(ctx: Context): string[] {
  const missing: string[] = [];
  if (!readGlobalConfig(ctx.env).harness) missing.push("harness: choose Claude Code, Codex or an API key to power OpenMerit Harness");
  if (!(readRepoConfig(ctx.repo.root).endpoints ?? []).length) missing.push("endpoints: add at least one candidate endpoint (default: OpenRouter, every model eligible)");
  return missing;
}

export function startRun(ctx: Context): string {
  const id = newRunId();
  const harness = readGlobalConfig(ctx.env).harness!;
  ctx.state.createRun({
    id, repo: ctx.repo, packageVersion: packageVersion(), catalogueVersion: ctx.catalogue.version,
    harness: `${harness.kind}${harness.kind === "api" ? `:${harness.api?.provider}/${harness.api?.model}` : harness.model ? `:${harness.model}` : ""}`,
    budgetUsd: readRepoConfig(ctx.repo.root).budget?.defaultUsd ?? DEFAULT_BUDGET_USD, state: {},
  });
  return id;
}
