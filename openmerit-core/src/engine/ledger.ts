// Spend accounting for model calls, reserve then settle: before a call is sent, its expected cost is
// reserved and refused when it would pass a cap; after it, the reservation is settled with what the
// call cost. Every operation is keyed, and repeating one changes nothing, so a workflow step that
// is replayed after a crash does not count its spend twice. The CLI's SQLite `State` and the cloud's
// account actor implement it; `MemoryLedger` is for tests.
import { requestPrice, type CatalogueModel } from "./catalogue.ts";

/** Who pays: OpenMerit's own keys, or the customer's keys on their own endpoints. */
export type Funding = "openmerit" | "customer";

export interface Reservation {
  /** One model call. Reserving a key that is reserved or settled changes nothing; a released key may be reserved again. */
  key: string;
  /** Expected cost, such as `expectedCost(...)`. */
  usd: number;
  funding: Funding;
  /** Labels kept with the record, such as for a report. */
  model?: string;
  endpoint?: string;
}

export type ReserveResult = { ok: true } | { ok: false; reason: string; neededUsd: number };

export interface Settlement {
  /** Provider-reported cost; null when the provider reports none. */
  actualUsd: number | null;
  /** List-price estimate used when there is no provider cost; null when not even that is known (the reservation then counts). */
  estimatedUsd: number | null;
  latencyMs?: number;
  /** The call failed or was cut off. It still counts what it cost. */
  failed?: boolean;
}

export interface Ledger {
  /** Refused, recording nothing, when this reservation would take its funding past its cap. */
  reserve(input: Reservation): Promise<ReserveResult>;
  /** Records what the call cost. Settling a settled or released key changes nothing; settling a key never reserved throws. */
  settle(key: string, cost: Settlement): Promise<void>;
  /** Drops a reservation whose call was never sent. Releasing a settled or unknown key changes nothing. */
  release(key: string): Promise<void>;
  /** Settled cost plus reservations still in flight, which count at their reserved amount, split by who pays. */
  spent(): Promise<{ openmeritUsd: number; customerUsd: number }>;
}

/**
 * What a settled call counts: the provider's cost, else the list-price estimate, else its reservation.
 * An estimate never counts more than the reservation, which priced the request's whole prompt and its
 * maximum output: a call cannot cost more, however many bytes a stream sent.
 */
export const settledUsd = (reservedUsd: number, cost: Settlement) => cost.actualUsd ?? Math.min(cost.estimatedUsd ?? reservedUsd, reservedUsd);

const label: Record<Funding, string> = { openmerit: "OpenMerit-paid", customer: "customer-paid" };

/** An in-memory ledger with an optional cap per funding. */
export class MemoryLedger implements Ledger {
  private readonly entries = new Map<string, { funding: Funding; reservedUsd: number; cost: Settlement | null }>();
  private readonly released = new Set<string>();
  private readonly caps: Partial<Record<Funding, number>>;
  constructor(caps: Partial<Record<Funding, number>> = {}) { this.caps = caps; }

  private total(funding: Funding) {
    let usd = 0;
    for (const entry of this.entries.values()) if (entry.funding === funding) usd += entry.cost ? settledUsd(entry.reservedUsd, entry.cost) : entry.reservedUsd;
    return usd;
  }

  async reserve(input: Reservation): Promise<ReserveResult> {
    if (!Number.isFinite(input.usd) || input.usd < 0) throw new RangeError(`Reservation ${input.key}: expected cost must be a non-negative number, got ${input.usd}`);
    if (this.entries.has(input.key)) return { ok: true };
    const cap = this.caps[input.funding], used = this.total(input.funding);
    if (cap !== undefined && used + input.usd > cap + 1e-9) return { ok: false, reason: `$${used.toFixed(4)} used or reserved of the $${cap.toFixed(2)} ${label[input.funding]} cap`, neededUsd: input.usd };
    this.entries.set(input.key, { funding: input.funding, reservedUsd: input.usd, cost: null });
    this.released.delete(input.key);
    return { ok: true };
  }

  async settle(key: string, cost: Settlement) {
    const entry = this.entries.get(key);
    if (!entry) { if (this.released.has(key)) return; throw new Error(`No reservation ${key} to settle`); }
    entry.cost ??= { ...cost, estimatedUsd: cost.estimatedUsd === null ? null : Math.min(cost.estimatedUsd, entry.reservedUsd) };
  }

  async release(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.cost) return;
    this.entries.delete(key);
    this.released.add(key);
  }

  async spent() { return { openmeritUsd: this.total("openmerit"), customerUsd: this.total("customer") }; }
}

/** Assumed output tokens when a request sets no maximum; reasoning models can use many. */
export const DEFAULT_OUTPUT_TOKENS = 4096;
/** Reservation for a request whose price is unknown. */
export const UNKNOWN_PRICE_RESERVATION_USD = 0.05;

/** What to reserve for an OpenAI-style request: its prompt size (about three bytes a token) and maximum output at list price. */
export function expectedCost(model: CatalogueModel | null | undefined, body: Record<string, unknown>, bodyBytes: number): { usd: number; priced: boolean; outputTokens: number } {
  const output = ([body.max_completion_tokens, body.max_tokens, body.max_output_tokens].find(value => typeof value === "number" && value > 0) as number | undefined) ?? DEFAULT_OUTPUT_TOKENS;
  const price = requestPrice(model ?? null, Math.ceil(bodyBytes / 3), output);
  return price === null ? { usd: UNKNOWN_PRICE_RESERVATION_USD, priced: false, outputTokens: output } : { usd: price, priced: true, outputTokens: output };
}

/**
 * A list-price estimate from the bytes sent and received, for an answer that reports no token usage (or was cut off):
 * about three bytes a token, which overcounts JSON and SSE framing. Null when the model has no price.
 */
export const sizeEstimate = (model: CatalogueModel | null | undefined, sentBytes: number, receivedBytes: number) => requestPrice(model ?? null, Math.ceil(sentBytes / 3), Math.ceil(receivedBytes / 3));

/** Token counts and provider cost from an OpenAI-style (or OpenRouter) response body or SSE stream. */
export function readUsage(text: string): { input: number; output: number; costUsd: number | null } | null {
  const candidates: string[] = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(line => line.startsWith("{"));
  let found: { input: number; output: number; costUsd: number | null } | null = null;
  for (const chunk of candidates) {
    try {
      const value = JSON.parse(chunk) as { usage?: Record<string, unknown>; response?: { usage?: Record<string, unknown> } };
      const usage = value.usage ?? value.response?.usage;
      if (!usage) continue;
      const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0), output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      found = { input, output, costUsd: typeof usage.cost === "number" ? usage.cost : null };
    } catch { /* not JSON */ }
  }
  return found;
}
