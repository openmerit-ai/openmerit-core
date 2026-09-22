import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  EvidenceManifest,
  OpenMeritAuditEvent,
  OpenMeritProjectConfig,
  OpenMeritProjectState,
} from "@openmerit-v2/protocol";

export const OPENMERIT_DIRECTORY = ".openmerit";

export interface OpenMeritStore {
  initialize(config: OpenMeritProjectConfig, state: OpenMeritProjectState): Promise<void>;
  readConfig(): Promise<OpenMeritProjectConfig | undefined>;
  writeConfig(config: OpenMeritProjectConfig): Promise<void>;
  readState(): Promise<OpenMeritProjectState | undefined>;
  writeState(state: OpenMeritProjectState): Promise<void>;
  appendEvent(event: OpenMeritAuditEvent): Promise<void>;
  writeEvidenceManifest(manifest: EvidenceManifest): Promise<string>;
}

export class ProjectStore implements OpenMeritStore {
  readonly directory: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly evidenceDirectory: string;

  constructor(projectRoot: string) {
    this.directory = join(projectRoot, OPENMERIT_DIRECTORY);
    this.configPath = join(this.directory, "config.json");
    this.statePath = join(this.directory, "state.json");
    this.eventsPath = join(this.directory, "events.jsonl");
    this.evidenceDirectory = join(this.directory, "evidence");
  }

  async initialize(config: OpenMeritProjectConfig, state: OpenMeritProjectState): Promise<void> {
    await mkdir(this.evidenceDirectory, { recursive: true });
    await this.writeConfig(config);
    await this.writeState(state);
  }

  async readConfig(): Promise<OpenMeritProjectConfig | undefined> {
    return readJsonIfPresent<OpenMeritProjectConfig>(this.configPath);
  }

  async writeConfig(config: OpenMeritProjectConfig): Promise<void> {
    await atomicWriteJson(this.configPath, config);
  }

  async readState(): Promise<OpenMeritProjectState | undefined> {
    return readJsonIfPresent<OpenMeritProjectState>(this.statePath);
  }

  async writeState(state: OpenMeritProjectState): Promise<void> {
    await atomicWriteJson(this.statePath, state);
  }

  async appendEvent(event: OpenMeritAuditEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true });
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async writeEvidenceManifest(manifest: EvidenceManifest): Promise<string> {
    const path = join(this.evidenceDirectory, `${safeFileComponent(manifest.id)}.json`);
    await atomicWriteJson(path, manifest);
    return path;
  }
}

function safeFileComponent(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new Error("Evidence manifest ID is not file-safe.");
  return safe;
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}
