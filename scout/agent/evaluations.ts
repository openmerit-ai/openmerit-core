import { DurableObject } from 'cloudflare:workers';
import { importLangfuse, LangfuseRateLimitError, parseLangfuse, verifyViewer, type LangfuseConfig } from '../langfuse.ts';
import type { Measurement, MeasurementInput } from './recommendation.ts';

interface EvaluationEnv { SCOUT_CONNECTOR_KEY?: string }
interface Encrypted { iv: number[]; data: number[] }
interface Saved { measurement: Measurement; at: number; origin: 'reported' | 'langfuse' }
const lifetime = 90 * 86400_000;

function checkCapacity(rows: Saved[]): void {
  if (rows.length > 5000 || new TextEncoder().encode(JSON.stringify(rows)).length > 1_000_000) {
    throw new Error('Evaluation storage is full (5,000 aggregates or 1 MB). Delete old results before adding more.');
  }
}

// One user's connector and measurements. Nothing is shared across users or
// copied into conversation storage. A separate secret encrypts the whole config.
export class ScoutEvaluations extends DurableObject<EvaluationEnv> {
  private busy = false;
  private generation = 0;

  private async key(): Promise<CryptoKey> {
    if (!this.env.SCOUT_CONNECTOR_KEY) throw new Error('Langfuse connections are not enabled on this server yet.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.SCOUT_CONNECTOR_KEY));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private async encrypt(config: LangfuseConfig): Promise<Encrypted> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(this.ctx.id.toString()) }, await this.key(), new TextEncoder().encode(JSON.stringify(config)));
    return { iv: [...iv], data: [...new Uint8Array(data)] };
  }
  private async decrypt(encrypted: Encrypted): Promise<LangfuseConfig> {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(encrypted.iv), additionalData: new TextEncoder().encode(this.ctx.id.toString()) }, await this.key(), new Uint8Array(encrypted.data));
    return parseLangfuse(JSON.parse(new TextDecoder().decode(data)));
  }
  async status() {
    const state = await this.ctx.storage.get<{ connectedAt: number; syncedAt?: number; experiments?: number; unmapped?: number }>('connection');
    const encrypted = await this.ctx.storage.get<Encrypted>('credentials');
    const config = encrypted ? await this.decrypt(encrypted) : undefined;
    const measurements = await this.measurements();
    return { connected: !!state, ...state, mappingCount: config?.mappings.length ?? 0,
      modelAliasCount: Object.keys(config?.models ?? {}).length, results: measurements.length, busy: this.busy };
  }
  async configure(input: unknown) {
    if (this.busy) throw new Error('A Langfuse request is already running. Try again shortly.');
    const generation = this.generation;
    this.busy = true;
    try {
      let value = input;
      if (input && typeof input === 'object' && !Array.isArray(input) && !('publicKey' in input) && !('secretKey' in input)) {
        if (Object.keys(input).some(key => !['region', 'from', 'tagPrefix', 'mappings', 'models'].includes(key))) throw new Error('Langfuse settings contain an unsupported field.');
        const saved = await this.ctx.storage.get<Encrypted>('credentials');
        if (!saved) throw new Error('Connect Langfuse with a separate Viewer key before updating settings.');
        const previous = await this.decrypt(saved);
        value = { ...previous, ...input };
      }
      const config = parseLangfuse(value);
      // Fail before making upstream calls if encryption is not provisioned.
      const encrypted = await this.encrypt(config);
      await verifyViewer(config);
      await this.ctx.storage.transaction(async storage => {
        const old = (await storage.get<Saved[]>('results')) ?? [];
        if (generation !== this.generation) throw new Error('Connection cancelled by disconnect.');
        await storage.put({ credentials: encrypted, connection: { connectedAt: Date.now() }, results: old.filter(r => r.origin !== 'langfuse' && r.at > Date.now() - lifetime), nextSync: 0, activeAt: Date.now() });
        await storage.setAlarm(Date.now() + 86400_000);
      });
      return this.status();
    } finally { this.busy = false; }
  }
  async sync() {
    if (this.busy) throw new Error('A Langfuse request is already running. Try again shortly.');
    this.busy = true;
    const generation = this.generation;
    let retryAt = 0;
    try {
      const encrypted = await this.ctx.storage.get<Encrypted>('credentials');
      if (!encrypted) throw new Error('Connect Langfuse at https://openmerit.ai/connect/?integration=langfuse first.');
      retryAt = (await this.ctx.storage.get<number>('retryAt')) ?? 0;
      if (Date.now() < retryAt) throw new LangfuseRateLimitError(Math.ceil((retryAt - Date.now()) / 1000));
      if (Date.now() < ((await this.ctx.storage.get<number>('nextSync')) ?? 0)) return { ...await this.status(), cached: true };
      await this.ctx.storage.put('nextSync', Date.now() + 60_000);
      const imported = await importLangfuse(await this.decrypt(encrypted));
      const at = Date.now();
      const rows: Saved[] = imported.results.map(r => ({ measurement: { id: `lf_${crypto.randomUUID()}`, ...r }, at, origin: 'langfuse' }));
      await this.ctx.storage.transaction(async storage => {
        const connection = await storage.get<{ connectedAt: number }>('connection');
        const saved = (await storage.get<Saved[]>('results')) ?? [];
        if (generation !== this.generation || !connection) throw new Error('Sync cancelled by disconnect.');
        const results = [...saved.filter(r => r.origin !== 'langfuse' && r.at > at - lifetime), ...rows];
        checkCapacity(results);
        await storage.put({ results, nextSync: at + 10 * 60_000, activeAt: at,
          connection: { ...connection, syncedAt: at, experiments: imported.experiments, unmapped: imported.unmapped } });
        await storage.setAlarm(at + 86400_000);
      });
      return { ...await this.status(), cached: false };
    } catch (error) {
      if (error instanceof LangfuseRateLimitError && Date.now() >= retryAt && generation === this.generation) {
        await this.ctx.storage.put('retryAt', Date.now() + error.retryAfter * 1000);
      }
      throw error;
    } finally { this.busy = false; }
  }
  async disconnect() {
    this.generation++;
    await this.ctx.storage.transaction(async storage => {
      const saved = (await storage.get<Saved[]>('results')) ?? [];
      await storage.put('results', saved.filter(r => r.origin !== 'langfuse'));
      await storage.delete(['credentials', 'connection', 'nextSync', 'retryAt']);
    });
    return { connected: false, deleted: 'Langfuse credentials and imported aggregates' };
  }
  async report(results: MeasurementInput[]): Promise<Measurement[]> {
    if (!results.length) return [];
    return this.ctx.storage.transaction(async storage => {
      const saved = ((await storage.get<Saved[]>('results')) ?? []).filter(r => r.at > Date.now() - lifetime);
      const added: Measurement[] = [];
      for (const result of results) {
        const same = (r: MeasurementInput) => ['level', 'kind', 'task', 'scope', 'model', 'metric', 'source'].every(k => r[k as keyof MeasurementInput] === result[k as keyof MeasurementInput]);
        const old = saved.find(r => r.origin === 'reported' && same(r.measurement));
        const measurement = { id: old?.measurement.id ?? `r_${crypto.randomUUID()}`, ...result };
        if (old) { old.measurement = measurement; old.at = Date.now(); }
        else saved.push({ measurement, at: Date.now(), origin: 'reported' });
        added.push(measurement);
      }
      checkCapacity(saved);
      await storage.put({ results: saved, activeAt: Date.now() });
      await storage.setAlarm(Date.now() + 86400_000);
      return added;
    });
  }
  async measurements(): Promise<Measurement[]> {
    return ((await this.ctx.storage.get<Saved[]>('results')) ?? []).filter(r => r.at > Date.now() - lifetime).map(r => r.measurement);
  }
  async clear() {
    this.generation++;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return { deleted: 'All evaluation credentials and aggregates' };
  }
  override async alarm() {
    const at = Date.now();
    if (((await this.ctx.storage.get<number>('activeAt')) ?? 0) <= at - lifetime) { await this.clear(); return; }
    const saved = (await this.ctx.storage.get<Saved[]>('results')) ?? [];
    await this.ctx.storage.put('results', saved.filter(r => r.at > at - lifetime));
    await this.ctx.storage.setAlarm(at + 86400_000);
  }
}
