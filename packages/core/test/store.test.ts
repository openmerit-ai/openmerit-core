import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { OpenMeritProjectConfig, OpenMeritProjectState } from "@openmerit-v2/protocol";
import { ProjectStore } from "../src/index.ts";

test("persists project-local snapshots, audit events, and evidence manifests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openmerit-v2-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const config: OpenMeritProjectConfig = { schemaVersion: 1, taskProfiles: [] };
  const state: OpenMeritProjectState = {
    schemaVersion: 1,
    cycle: {
      id: "cycle-1",
      stage: "unconfigured",
      verifiedSwapCount: 0,
      baselineEvidenceSufficient: false,
    },
    automation: {
      setupNudgeShown: false,
      observedCompletedTasks: 0,
      lastAssessmentTaskCount: 0,
    },
    updatedAt: "2026-09-22T00:00:00.000Z",
  };

  await store.initialize(config, state);
  await store.appendEvent({
    schemaVersion: 1,
    id: "event-1",
    type: "project_initialized",
    occurredAt: "2026-09-22T00:00:00.000Z",
    cycleId: "cycle-1",
    data: {},
  });
  const manifestPath = await store.writeEvidenceManifest({
    schemaVersion: 1,
    id: "evidence-1",
    createdAt: "2026-09-22T00:01:00.000Z",
    taskProfileId: "task-1",
    references: [{ id: "trace-1", source: "harness_trace", uri: "session://pi/trace-1" }],
  });

  assert.deepEqual(await store.readConfig(), config);
  assert.deepEqual(await store.readState(), state);
  assert.match(await readFile(store.eventsPath, "utf8"), /project_initialized/);
  assert.match(await readFile(manifestPath, "utf8"), /session:\/\/pi\/trace-1/);
});

test("rejects unsafe evidence manifest identifiers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openmerit-v2-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  await assert.rejects(() => store.writeEvidenceManifest({
    schemaVersion: 1,
    id: "..",
    createdAt: "2026-09-22T00:00:00.000Z",
    taskProfileId: "task-1",
    references: [],
  }), /not file-safe/);
});

test("writes canonical redacted events and best-effort exporter failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openmerit-v2-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const exported: unknown[] = [];
  const store = new ProjectStore(root, {
    eventExporters: [
      { id: "working", async export(event) { exported.push(event); } },
      { id: "broken", async export() { throw new Error(`failed with ${"apikey_"}${"abcdefghijklmnopqrstuvwxyz"}`); } },
    ],
  });

  await store.appendEvent({
    schemaVersion: 1,
    id: "event-redacted",
    type: "automation_signal_recorded",
    occurredAt: "2026-09-22T00:00:00.000Z",
    cycleId: "cycle-1",
    data: {
      apiKey: `${"apikey_"}${"abcdefghijklmnopqrstuvwxyz"}`,
      message: `Authorization ${"sk-"}${"abcdefghijklmnopqrstuvwxyz"}`,
    },
  });

  const canonical = await readFile(store.eventsPath, "utf8");
  const exportErrors = await readFile(store.exportErrorsPath, "utf8");
  assert.doesNotMatch(canonical, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(canonical, /\[REDACTED\]/);
  assert.equal(exported.length, 1);
  assert.doesNotMatch(JSON.stringify(exported), /abcdefghijklmnopqrstuvwxyz/);
  assert.match(exportErrors, /"exporterId":"broken"/);
  assert.doesNotMatch(exportErrors, /abcdefghijklmnopqrstuvwxyz/);
});
