import type { ScoutReport } from "./pipeline.ts";

const usd = (value: number | null, digits = 5) => (value === null ? "unknown" : `$${value.toFixed(digits)}`);
const link = (label: string, url: string | null) => (url ? `[${label}](${url})` : label);
const eciCell = (eci: number, source: string) => `${eci.toFixed(1)}${source === "published" ? "" : ` (${source.slice(0, 4)}.)`}`;

/** The decision record as Markdown: no keys, no raw item contents. */
export function reportMarkdown(report: ScoutReport): string {
  const best = report.recommendation;
  const lines = [
    `# Scout recommendation: ${best ? `\`${best.model}\`` : "none"}`,
    "",
    `- Task: ${report.task.replace(/\s+/g, " ").slice(0, 500)}`,
    `- Run: \`${report.runId}\`, ${report.createdAt}`,
    `- Dataset: ${link(`\`${report.dataset.name}\``, report.dataset.url)} (${report.dataset.source}, ${report.dataset.size} labelled items)`,
    `- Candidates: ${report.candidates} runnable models with an Epoch Capabilities Index (published, or ScoutBM's estimate: "est."/"cali.")`,
    `- Langfuse: ${report.langfuse ? `${report.langfuse.project} at ${report.langfuse.baseUrl}, ${report.langfuse.experiments} experiments recorded` : "not connected"}`,
    `- Spend: ${usd(report.spend.measuredUsd, 4)} measured over ${report.spend.evaluations} evaluations${report.spend.unknownCostItems ? ` (${report.spend.unknownCostItems} without a cost)` : ""}${report.spend.openRouterCreditsUsd !== undefined ? `; OpenRouter account credit used during the run: ${usd(report.spend.openRouterCreditsUsd, 4)}` : ""}`,
    "",
    `**Why:** ${report.why}`,
    "",
    `## Finals (every item ${report.finals[0]?.runs ?? 1} times, one Langfuse experiment per run, read back from Langfuse)`,
    "",
    "| Rank | Model | Passes | Cost per item run | ECI | List price $/M in+out | Verified in Langfuse | Failed items |",
    "|---|---|---|---|---|---|---|---|",
    ...report.finals.map((item, index) => `| ${index + 1} | ${link(`\`${item.model}\``, item.experimentUrl)} | ${item.passes}/${item.total} | ${usd(item.costPerItemUsd)} | ${eciCell(item.eci, item.eciSource)} | ${item.listPrice === null ? "unknown" : item.listPrice.toFixed(2)} | ${item.verifiedInLangfuse ? "yes" : "no"}${item.missingScores.length ? ` (${item.missingScores.length} unscored)` : ""} | ${item.failedItems.map(id => `${id} (${item.passesByItem[id] ?? 0}/${item.runs})`).join(", ") || "none"} |`),
    "",
    `## Binary search (${report.search.criterion}; samples ${report.search.sampleIds.join(", ")})`,
    "",
    `Status: **${report.search.status}**${report.search.error ? ` — ${report.search.error}` : ""}. Search pick: ${report.search.selected ? `\`${report.search.selected.model}\`` : "none"}.`,
    "",
    "| # | Stage | Model | ECI | Passes | Verdict | Cost |",
    "|---|---|---|---|---|---|---|",
    ...report.search.trials.map((trial, index) => `| ${index + 1} | ${trial.stage} | ${link(`\`${trial.model}\``, trial.experimentUrl)} | ${eciCell(trial.eci, trial.eciSource)} | ${trial.passes}/${trial.total} | ${trial.accepted ? "pass" : "fail"} | ${usd(trial.costUsd, 4)} |`),
    ...(report.search.unavailable.length ? ["", "Skipped (could not run, untested):", "", ...report.search.unavailable.map(item => `- \`${item.model}\` (${item.stage}): ${item.reason.slice(0, 200)}`)] : []),
    "",
    `Rule: ${report.search.finalRule}`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map(item => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}
