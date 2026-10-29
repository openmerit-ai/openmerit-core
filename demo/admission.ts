// Preserve the deployed storage keys and allowance accounting across releases.
import { limits, taskLimits, getTask } from './runtime/site-config.ts';
import { sessionReservationLimit } from './security.mjs';
import { LIMITS as interactiveLimits } from './interactive/scenario.ts';

export interface DemoSession {
  id: string; token: string; task: string; createdAt: number; expiresAt: number;
  requests: number; reserved: number; closed?: boolean; admissionReleased?: boolean;
}
interface Day { date: string; count: number; starts?: number; networks: Record<string, number>; salt: string }
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  transaction<T>(callback: (storage: Storage) => Promise<T>): Promise<T>;
}
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
function releaseUnused(day: Day | undefined, session: DemoSession) {
  if (session.task !== 'constraints' || session.requests !== 0 || session.reserved !== 0 || session.admissionReleased || utcDay(session.createdAt) !== day?.date) return;
  day.count = Math.max(0, day.count - 1);
  session.admissionReleased = true;
}
export class AdmissionLedger {
  readonly storage: Storage;
  constructor(storage: Storage) { this.storage = storage; }
  async create(ip: string, task = 'support') {
    if (task !== 'constraints') getTask(task);
    const allowance = task === 'constraints' ? interactiveLimits : limits;
    const result = await this.storage.transaction(async storage => {
      const now = Date.now(), today = utcDay(now);
      let day = await storage.get<Day>('day');
      if (day?.date !== today) day = { date: today, count: 0, starts: 0, networks: {}, salt: random() };
      day.starts ??= day.count;
      const previous = await storage.get<DemoSession[]>('sessions') ?? [];
      for (const session of previous) if (session.closed || session.expiresAt <= now) releaseUnused(day, session);
      const sessions = previous.filter(s => s.expiresAt > now && !s.closed);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(day.salt + ip))), b => b.toString(16).padStart(2, '0')).join('');
      let error: string | undefined;
      if (day.count >= allowance.dailySessions || (task !== 'constraints' && (day.networks[hash] ?? 0) >= 3)) error = 'Today’s shared demo allowance is used. New sessions open at 00:00 UTC (4 a.m. Dubai).';
      else if (task === 'constraints' && day.starts >= allowance.dailySessions * 3) error = 'Today’s demo startup allowance is used. New sessions open at 00:00 UTC (4 a.m. Dubai).';
      else if (sessions.length >= allowance.concurrentSessions) error = 'Both demo sandboxes are busy. Please try again in a few minutes.';
      if (error) { await storage.put({ day, sessions }); return { error }; }
      const session: DemoSession = { id: random(), token: random(), task, createdAt: now, expiresAt: now + allowance.lifetimeSeconds * 1000, requests: 0, reserved: 0 };
      sessions.push(session); day.count++; day.starts++; day.networks[hash] = (day.networks[hash] ?? 0) + 1;
      await storage.put({ day, sessions });
      return { session };
    });
    if (result.error) throw new Error(result.error);
    return result.session!;
  }
  async get(id: string) { return (await this.storage.get<DemoSession[]>('sessions') ?? []).find(s => s.id === id && !s.closed && s.expiresAt > Date.now()) ?? null; }
  async close(id: string) {
    await this.storage.transaction(async storage => {
      const sessions = await storage.get<DemoSession[]>('sessions') ?? [], day = await storage.get<Day>('day');
      const session = sessions.find(s => s.id === id);
      if (session) { session.closed = true; releaseUnused(day, session); }
      await storage.put({ sessions, ...(day && { day }) });
    });
  }
  async reserve(id: string, token: string, cost: number) {
    return this.storage.transaction(async storage => {
      const sessions = await storage.get<DemoSession[]>('sessions') ?? [];
      const s = sessions.find(s => s.id === id && s.token === token && !s.closed && s.expiresAt > Date.now());
      if (!s) return false;
      const maxRequests = s.task === 'constraints' ? interactiveLimits.maximumRequests : taskLimits(s.task ?? 'support').maxRequests;
      const maxSpend = s.task === 'constraints' ? interactiveLimits.maximumSpend : sessionReservationLimit;
      if (!Number.isFinite(cost) || cost <= 0 || s.requests >= maxRequests || s.reserved + cost > maxSpend) return false;
      s.requests++; s.reserved += cost;
      await storage.put('sessions', sessions); return true;
    });
  }
}
