// Read-only health check of Scout's catalogue refresh, run twice a day by an Amp schedule.
// Reports failed public feeds (from /scout/api/status), catalogue imports that failed in the
// last day (cat_runs in D1) and a catalogue that has not published for 26 hours, as JSON.
// Exits 1 when there is a problem. The schedule posts problems to Slack through Amp's Slack connection.
//
// Usage: node scripts/scout-refresh-check.ts
import { execFileSync } from "node:child_process";

interface Problem { id: string; kind: "feed" | "catalogue" | "publication"; error: string; since: string | null }
const statusURL = "https://openmerit.ai/scout/api/status";
const staleHours = 26; // The refresh runs at 00:07 and 12:07 UTC.

const short = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").slice(0, 200);
const status = (await (await fetch(statusURL, { signal: AbortSignal.timeout(20_000) })).json()) as {
  checkedAt?: string; snapshotVersion?: string; sources?: Array<{ id: string; status: string; error?: string; checkedAt?: string }>;
};
const problems: Problem[] = (status.sources ?? []).filter(s => s.status === "failed")
  .map(s => ({ id: s.id, kind: "feed", error: short(s.error), since: s.checkedAt ?? null }));
const age = status.checkedAt ? (Date.now() - Date.parse(status.checkedAt)) / 3_600_000 : Infinity;
if (!(age < staleHours)) problems.push({ id: "catalogue", kind: "publication", error: `No catalogue published for ${Number.isFinite(age) ? `${Math.round(age)} hours` : "an unknown time"}.`, since: status.checkedAt ?? null });

// The cutoff is generated here, never taken from input, so it is safe to inline.
const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
try {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "openmerit-scout-index", "--remote", "-c", "wrangler.scout-alpha.jsonc", "--json", "--command",
    `SELECT source, status, error, max(started_at) AS started_at FROM cat_runs WHERE started_at > '${cutoff}' GROUP BY source HAVING status != 'ok'`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
  const rows = (JSON.parse(out) as Array<{ results: Array<{ source: string; status: string; error: string | null; started_at: string }> }>)[0]?.results ?? [];
  for (const r of rows) problems.push({ id: r.source, kind: "catalogue", error: short(r.error ?? (r.status === "running" ? "Import did not finish." : r.status)), since: r.started_at });
} catch (error) {
  console.error(`Could not read cat_runs from D1: ${short((error as Error).message)}`);
}

const report = { checkedAt: new Date().toISOString(), catalogue: { version: status.snapshotVersion ?? null, publishedAt: status.checkedAt ?? null }, problems };
console.log(JSON.stringify(report, null, 2));

if (problems.length) process.exitCode = 1;
