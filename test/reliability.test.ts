import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectDoctorReport, runOfflineVerify } from "../src/diagnostics.js";
import { taskJobIsClaimed } from "../src/comparison.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { appendJsonl, readJson, readJsonReport, readJsonlReport, writeJson } from "../src/store.js";
import { budgetOk, recordTrialSpend } from "../src/trials.js";

const previousHome = process.env.OPENMERIT_HOME;
const previousBin = process.env.OPENMERIT_PI_BIN;
let dir: string | null = null;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENMERIT_HOME;
  else process.env.OPENMERIT_HOME = previousHome;
  if (previousBin === undefined) delete process.env.OPENMERIT_PI_BIN;
  else process.env.OPENMERIT_PI_BIN = previousBin;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("state reliability", () => {
  it("writes JSON atomically and falls back when an interrupted file is unreadable", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-store-"));
    const file = join(dir, "state.json");
    writeJson(file, { value: 1 });
    expect(readJson(file, { value: 0 })).toEqual({ value: 1 });
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    writeFileSync(file, "{interrupted");
    expect(readJson(file, { value: 0 })).toEqual({ value: 0 });
    expect(readJsonReport(file, { value: 0 })).toMatchObject({ exists: true, valid: false });
  });

  it("skips malformed JSONL while preserving valid records after it", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-jsonl-"));
    const file = join(dir, "history.jsonl");
    appendJsonl(file, { id: "before" });
    appendFileSync(file, "{partial\n");
    appendJsonl(file, { id: "after" });
    expect(readJsonlReport<{ id: string }>(file)).toEqual({
      records: [{ id: "before" }, { id: "after" }], invalidLines: [2],
    });
  });

  it("fails closed instead of resetting a malformed spend ledger", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-ledger-"));
    process.env.OPENMERIT_HOME = dir;
    writeFileSync(join(dir, "ledger.json"), "{interrupted");
    expect(budgetOk(DEFAULT_POLICY)).toEqual({
      ok: false, reason: "trial ledger is malformed; run `openmerit doctor`",
    });
    expect(() => recordTrialSpend(0.01)).toThrow(/refusing to reset spend/);
  });

  it("reclaims abandoned work but preserves live and completed job claims", () => {
    const marker = "session:turn";
    expect(taskJobIsClaimed({ marker, status: "complete", updatedAt: new Date().toISOString() }, marker)).toBe(true);
    expect(taskJobIsClaimed({ marker, status: "failed", updatedAt: new Date().toISOString() }, marker)).toBe(false);
    expect(taskJobIsClaimed({ marker, status: "running", ownerPid: process.pid,
      updatedAt: new Date().toISOString() }, marker)).toBe(true);
    expect(taskJobIsClaimed({ marker, status: "running", ownerPid: 2_000_000_000,
      updatedAt: new Date().toISOString() }, marker)).toBe(false);
    expect(taskJobIsClaimed({ marker, status: "running", updatedAt: "2020-01-01T00:00:00Z" }, marker)).toBe(false);
  });

  it("runs the complete self-test without touching the configured state directory", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-verify-parent-"));
    process.env.OPENMERIT_HOME = dir;
    const report = runOfflineVerify();
    expect(report.ok).toBe(true);
    expect(report.checks.every((item) => item.status === "pass")).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("redacts local package paths from shareable doctor output", () => {
    dir = mkdtempSync(join(tmpdir(), "openmerit-doctor-"));
    process.env.OPENMERIT_HOME = join(dir, "state");
    mkdirSync(process.env.OPENMERIT_HOME, { recursive: true });
    writeFileSync(join(process.env.OPENMERIT_HOME, "policy.json"), JSON.stringify({
      pi: { provider_extensions: ["/Users/private/extensions/missing-provider.ts"] },
    }));
    const bin = join(dir, "pi");
    writeFileSync(bin, `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === '--version') console.log('0.85.1');
else if (cmd === 'list') console.log(['User packages:', '  npm:/Users/private/project/openmerit-0.1.3.tgz', '    /Users/private/cache/openmerit'].join(String.fromCharCode(10)));
else if (process.argv.includes('--list-models')) console.log(['provider model context max-out thinking images', 'native a 8.2K 4.1K no no', 'local b 8.2K 4.1K no no'].join(String.fromCharCode(10)));
`);
    chmodSync(bin, 0o755);
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    expect(probe.status, probe.stderr).toBe(0);
    process.env.OPENMERIT_PI_BIN = bin;
    const report = collectDoctorReport();
    const rendered = JSON.stringify(report);
    expect(rendered).toContain("npm:local/openmerit-0.1.3.tgz");
    expect(rendered).toContain("local:missing-provider.ts");
    expect(rendered).not.toContain("/Users/private");
  });
});
