// Billing behind one interface: Stripe Checkout, the customer portal, signature-verified webhooks
// and metered usage. `StripeBilling` calls Stripe's REST API with fetch; `FakeBilling` keeps the same
// contract in memory for tests. Both verify webhook signatures the same way, so tests exercise the
// real check. The webhook is the source of truth for an account's plan.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { StripeConfig } from "./config.ts";

export interface Billing {
  checkout(input: { accountId: string; customerId: string | null; email: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  portal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Reports one evaluation beyond the plan. `identifier` makes a retry count once. */
  reportUsage(input: { customerId: string; identifier: string; quantity: number }): Promise<void>;
  /** The event, when `signature` (the Stripe-Signature header) signs `payload`; otherwise throws. */
  verifyWebhook(payload: string, signature: string | null): StripeEvent;
}

export interface StripeEvent { id: string; type: string; created: number; data: { object: Record<string, unknown> } }

/** What a webhook tells the account actor. */
export type PlanUpdate =
  | { kind: "customer"; accountId: string; eventId: string; customerId: string }
  | { kind: "subscription"; accountId: string; eventId: string; eventCreated: number; customerId: string; subscriptionId: string; name: string; status: string; periodStart: number | null; periodEnd: number | null; includedEvals: number; overage: "metered" | "refuse" };

const TOLERANCE_S = 300;

/** Stripe's scheme: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`, within five minutes. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now = Date.now()): StripeEvent {
  if (!header) throw new Error("Missing Stripe-Signature");
  const parts = header.split(",").map(part => part.split("=") as [string, string]);
  const timestamp = Number(parts.find(([name]) => name === "t")?.[1]);
  const signatures = parts.filter(([name]) => name === "v1").map(([, value]) => value);
  if (!Number.isFinite(timestamp) || !signatures.length) throw new Error("Malformed Stripe-Signature");
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_S) throw new Error("Stripe-Signature is too old");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  const match = signatures.some(value => {
    const given = Buffer.from(value, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) throw new Error("Stripe-Signature does not match");
  return JSON.parse(payload) as StripeEvent;
}

/** A Stripe-Signature header for `payload`: for tests and the fake. */
export function signStripePayload(payload: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);
const record = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

/** The plan change an event carries, or null for events the app ignores. */
export function planUpdate(event: StripeEvent): PlanUpdate | null {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    const accountId = str(object.client_reference_id), customerId = str(object.customer);
    return accountId && customerId ? { kind: "customer", accountId, eventId: event.id, customerId } : null;
  }
  if (!event.type.startsWith("customer.subscription.")) return null;
  const accountId = str(record(object.metadata).account_id);
  const customerId = str(object.customer), subscriptionId = str(object.id);
  if (!accountId || !customerId || !subscriptionId) return null;
  const item = record((record(object.items).data as unknown[] | undefined)?.[0]);
  const price = record(item.price);
  const metadata = record(price.metadata);
  const included = Number(metadata.included_evals);
  return {
    kind: "subscription", accountId, eventId: event.id, eventCreated: event.created, customerId, subscriptionId,
    name: str(price.nickname) ?? str(metadata.plan) ?? "OpenMerit",
    status: event.type === "customer.subscription.deleted" ? "canceled" : str(object.status) ?? "incomplete",
    // API versions from 2025-03-31 moved the period onto the subscription item.
    periodStart: num(object.current_period_start) ?? num(item.current_period_start),
    periodEnd: num(object.current_period_end) ?? num(item.current_period_end),
    includedEvals: Number.isFinite(included) ? included : 0,
    overage: metadata.overage === "metered" ? "metered" : "refuse",
  };
}

function form(values: Record<string, string | number | null | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) body.set(key, String(value));
  return body.toString();
}

export class StripeBilling implements Billing {
  private readonly config: StripeConfig;
  private readonly request: typeof fetch;
  constructor(config: StripeConfig, request: typeof fetch = fetch) { this.config = config; this.request = request; }

  private async post<T>(path: string, values: Record<string, string | number | null | undefined>, idempotencyKey?: string): Promise<T> {
    const response = await this.request(`${this.config.apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`, "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: form(values),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(`Stripe ${path}: ${data.error?.message ?? `HTTP ${response.status}`}`);
    return data;
  }

  async checkout(input: Parameters<Billing["checkout"]>[0]) {
    const session = await this.post<{ url: string }>("/v1/checkout/sessions", {
      mode: "subscription", "line_items[0][price]": this.config.priceId, "line_items[0][quantity]": 1,
      client_reference_id: input.accountId, "subscription_data[metadata][account_id]": input.accountId,
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
      success_url: input.successUrl, cancel_url: input.cancelUrl,
    });
    return { url: session.url };
  }

  async portal(input: Parameters<Billing["portal"]>[0]) {
    const session = await this.post<{ url: string }>("/v1/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl });
    return { url: session.url };
  }

  async reportUsage(input: Parameters<Billing["reportUsage"]>[0]) {
    await this.post("/v1/billing/meter_events", {
      event_name: this.config.meterEvent, identifier: input.identifier,
      "payload[stripe_customer_id]": input.customerId, "payload[value]": input.quantity,
    }, input.identifier);
  }

  verifyWebhook(payload: string, signature: string | null) { return verifyStripeSignature(payload, signature, this.config.webhookSecret); }
}

/** Billing for tests: Checkout and portal URLs that go nowhere, usage kept in memory. */
export class FakeBilling implements Billing {
  readonly usage: { customerId: string; identifier: string; quantity: number }[] = [];
  readonly checkouts: Parameters<Billing["checkout"]>[0][] = [];
  readonly webhookSecret: string;
  constructor(webhookSecret = "whsec_test") { this.webhookSecret = webhookSecret; }
  async checkout(input: Parameters<Billing["checkout"]>[0]) { this.checkouts.push(input); return { url: `https://checkout.stripe.test/${encodeURIComponent(input.accountId)}` }; }
  async portal(input: Parameters<Billing["portal"]>[0]) { return { url: `https://billing.stripe.test/${encodeURIComponent(input.customerId)}` }; }
  async reportUsage(input: Parameters<Billing["reportUsage"]>[0]) {
    if (!this.usage.some(item => item.identifier === input.identifier)) this.usage.push(input);
  }
  verifyWebhook(payload: string, signature: string | null) { return verifyStripeSignature(payload, signature, this.webhookSecret); }
}
