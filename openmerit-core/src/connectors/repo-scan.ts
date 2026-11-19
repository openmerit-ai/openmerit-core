// The repository as a connection, for the local CLI: the scan lists where code names models (the
// Source port and the code refs), and its Change port is Configure's narrow edit. The edit itself is
// openmerit/engine's `proposeEdit`; this connector adds the checks only the repository can answer:
// that the code calls the pick's endpoint, and that no other task or shared setting uses the line.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogueIndex, type Catalogue } from "../engine/catalogue.ts";
import { proposeEdit, respell, type Edit, type EditTarget, type ProposedChange } from "../engine/change.ts";
import type { Connector } from "../engine/connector.ts";
import type { EvidencePart } from "../engine/evidence.ts";
import { redact } from "../engine/redact.ts";
import { sourceFiles, type Usage } from "../scout/scan.ts";

export interface RepoTask { name: string; usageIds: string[] }
export interface RepoEndpoint { id: string; kind: string; baseUrl: string }

/** An edit Configure can apply: `hash` is the line's hash when it was planned, so a changed line is never edited. */
export interface RepoEdit extends Edit { hash: string }
export interface RepoChange extends ProposedChange { edits: RepoEdit[]; manual: string[] }

export interface RepoScanInput {
  root: string;
  exclude: readonly string[];
  catalogue: Catalogue;
  /** Every usage the scan found. */
  usages: readonly Usage[];
  tasks: readonly RepoTask[];
  /** The usages Scout reviews for the current model. */
  reviewed: (usage: Usage | undefined) => usage is Usage;
  currentModel: string;
  endpoint: (id: string) => RepoEndpoint;
}

/** A task the user chose in Scout: it is evaluated because they asked, not for its recorded spend. */
export const chosenTask: EvidencePart = { priority: [{ value: { kind: "request" }, source: { connector: "repo-scan", detail: "the task you chose" } }] };

const ref = (usage: Usage) => `${usage.file}:${usage.line}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** A Connector whose Change port also returns the instructions Configure lists separately (`manual`) and each line's hash. */
export function repoScan(input: RepoScanInput): Omit<Connector, "change"> & { change: { propose: (task: string, target: EditTarget) => RepoChange } } {
  const byId = new Map(input.usages.map(usage => [usage.id, usage]));
  const usagesOf = (task: string) => (input.tasks.find(item => item.name === task)?.usageIds ?? []).map(id => byId.get(id)).filter(input.reviewed);
  return {
    id: "repo-scan", capabilities: ["list", "evidence", "change"], writes: false,
    list: () => input.tasks.map(task => ({ name: task.name, currentModel: input.currentModel })),
    evidence: (task): EvidencePart => ({
      ...chosenTask,
      refs: usagesOf(task).filter(usage => !usage.dynamic || usage.catalogueId).map(usage => ({ value: { file: usage.file, line: usage.line, spelling: usage.snippet, literal: usage.value }, source: { connector: "repo-scan", detail: ref(usage) } })),
    }),
    change: { propose: (task, target) => planEdit(input, task, target, usagesOf(task)) },
  };
}

/** The narrow edit for a configure "Yes": the task's literal model IDs, when the app already calls the winner's endpoint. */
function planEdit(input: RepoScanInput, taskName: string, winner: EditTarget, usages: readonly Usage[]): RepoChange {
  const endpoint = input.endpoint(winner.endpoint);
  const endpointUsages = input.usages.filter(usage => usage.kind === "endpoint");
  // The application calls the provider, not OpenMerit's eval route: match OpenAI and OpenRouter by their public hosts.
  const host = endpoint.kind === "openai" ? "api.openai.com" : endpoint.kind === "openrouter" ? "openrouter.ai" : new URL(endpoint.baseUrl).host;
  const edits: RepoEdit[] = [];
  const manual: string[] = [];
  for (const usage of usages) {
    const fileEndpoints = endpointUsages.filter(item => item.file === usage.file);
    const sameEndpoint = (fileEndpoints.length ? fileEndpoints : endpointUsages).some(item => item.value.includes(host)) || (!endpointUsages.length && endpoint.kind === "openai");
    const style = usage.value.includes("/") ? "openrouter" : "openai";
    if (usage.dynamic && !usage.catalogueId) { manual.push(`${ref(usage)} reads ${usage.envVar ?? usage.value} at run time: set it to ${winner.endpointModel} where that environment is configured (OpenMerit cannot change your shell's environment).`); continue; }
    if (!sameEndpoint || (style === "openrouter") !== (endpoint.kind === "openrouter")) { manual.push(`${ref(usage)} calls a different endpoint than ${endpoint.id}: switching needs an endpoint change too. Point it at ${endpoint.baseUrl} and use model ${winner.endpointModel}.`); continue; }
    const pick = { ...winner, onOpenRouter: endpoint.kind === "openrouter" };
    const target = respell(usage.value, pick);
    const lines = readFileSync(join(input.root, usage.file), "utf8").split("\n");
    const raw = lines[usage.line - 1] ?? "";
    const [edit] = proposeEdit({ task: taskName, current: input.currentModel, refs: [{ file: usage.file, line: usage.line, spelling: raw, literal: usage.value }], pick, baselineEndpoint: null, find: catalogueIndex(input.catalogue).find }).edits;
    if (!edit) { manual.push(`${ref(usage)}: change ${usage.value} to ${target} by hand.`); continue; }
    // Never switch code Scout did not evaluate for this task: a line other tasks use, or a module-level setting used in several places.
    const others = input.tasks.filter(other => other.name !== taskName && other.usageIds.includes(usage.id)).map(other => other.name);
    if (others.length) { manual.push(`${ref(usage)} also serves ${others.join(", ")}: editing it would switch ${others.length === 1 ? "that task" : "those tasks"} too, which Scout did not evaluate. Give ${taskName} its own model setting of ${target}, or change it by hand if all of them should switch.`); continue; }
    const shared = sharedDefinition(input, usage, lines);
    if (shared) { manual.push(`${ref(usage)} sets ${shared.name}, which ${shared.uses.length} other places use (${shared.uses.slice(0, 3).join(", ")}${shared.uses.length > 3 ? ", …" : ""}): editing it would switch all of them, not only ${taskName}. Give ${taskName} its own model setting of ${target}, or change ${shared.name} by hand if every use should switch.`); continue; }
    edits.push({ file: usage.file, line: usage.line, before: redact(raw), after: redact(edit.after), hash: hash(raw), from: usage.value, to: edit.to });
    if (usage.envVar) manual.push(`${ref(usage)}: ${usage.envVar} overrides this default when it is set; update it too if your environment sets it.`);
  }
  return { edits, manual, instructions: manual.length ? manual.join(" ") : null };
}

/**
 * When the model literal is part of a module-level setting (`const SONNET = { id: "…" }`, `MODEL = "…"`) used in more
 * than one other place, its name and those places: editing it would switch every one of them. Null otherwise, including
 * literals inside a function or call, which only that code uses.
 */
function sharedDefinition(input: RepoScanInput, usage: Usage, lines: readonly string[]): { name: string; uses: string[] } | null {
  // The top-level statement the literal belongs to: the nearest line at or above it that is not indented.
  let start = usage.line - 1;
  while (start > 0 && start > usage.line - 60 && /^\s/.test(lines[start] ?? "")) start--;
  const declared = /^(?:export\s+)?(?:(?:const|let|var|final|static|val)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?![=>])/.exec(lines[start] ?? "");
  const name = declared?.[1];
  if (!name || /^(?:if|for|while|return|module)$/.test(name)) return null;
  const pattern = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  const uses: string[] = [];
  for (const file of sourceFiles(input.root, input.exclude)) {
    let text: string;
    try { text = readFileSync(join(input.root, file), "utf8"); } catch { continue; }
    if (text.length > 512_000 || !text.includes(name)) continue;
    text.split("\n").forEach((line, index) => {
      // The declaration itself, from its first line to the literal, is not a use.
      if (file === usage.file && index >= start && index <= usage.line - 1) return;
      for (const _ of line.matchAll(pattern)) uses.push(`${file}:${index + 1}`);
    });
  }
  return uses.length > 1 ? { name, uses } : null;
}
