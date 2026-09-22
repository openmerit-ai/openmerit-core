import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  EvidenceManifest,
  OpenMeritAuditEvent,
  OpenMeritProjectConfig,
  OpenMeritProjectState,
} from "../../protocol/src/index.ts";

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

export interface AuditEventExporter {
  readonly id: string;
  export(event: OpenMeritAuditEvent): Promise<void>;
}

export interface ProjectStoreOptions {
  readonly eventExporters?: readonly AuditEventExporter[];
}

export class ProjectStore implements OpenMeritStore {
  readonly directory: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly exportErrorsPath: string;
  readonly evidenceDirectory: string;
  private readonly eventExporters: readonly AuditEventExporter[];

  constructor(projectRoot: string, options: ProjectStoreOptions = {}) {
    this.directory = join(projectRoot, OPENMERIT_DIRECTORY);
    this.configPath = join(this.directory, "config.json");
    this.statePath = join(this.directory, "state.json");
    this.eventsPath = join(this.directory, "events.jsonl");
    this.exportErrorsPath = join(this.directory, "audit-export-errors.jsonl");
    this.evidenceDirectory = join(this.directory, "evidence");
    this.eventExporters = options.eventExporters ?? [];
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
    const safeEvent = redactSensitive(event) as unknown as OpenMeritAuditEvent;
    await appendFile(this.eventsPath, `${JSON.stringify(safeEvent)}\n`, { encoding: "utf8", mode: 0o600 });
    const results = await Promise.allSettled(this.eventExporters.map((exporter) => exporter.export(safeEvent)));
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      await appendFile(this.exportErrorsPath, `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        eventId: safeEvent.id,
        exporterId: this.eventExporters[index]?.id ?? "unknown",
        error: safeErrorMessage(result.reason),
      })}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  async writeEvidenceManifest(manifest: EvidenceManifest): Promise<string> {
    const path = join(this.evidenceDirectory, `${safeFileComponent(manifest.id)}.json`);
    await atomicWriteJson(path, redactSensitive(manifest));
    return path;
  }
}

const SENSITIVE_KEY = /(?:authorization|api[_-]?key|token|secret|password|cookie)/i;
const SECRET_VALUE = /\b(?:sk-[a-zA-Z0-9_-]{12,}|apikey_[a-zA-Z0-9_-]{12,})\b/g;

function redactSensitive(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replaceAll(SECRET_VALUE, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactSensitive(child, childKey),
    ]));
  }
  return value;
}

function safeErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactSensitive(message) as string;
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
